import { pollUntil } from './shots-input';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import { effects } from './effects';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const exists = (file: string) => stat(file).then(() => true, () => false);
// 验收里的 git 也只用隔离环境（GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM 见 tools/demo/preferences.mjs），
// 绝不读写用户真实的全局配置。
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};
// 允许失败的非零退出（读不到身份时 git config --get 返回 1）。
const gitStatus = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
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

// 在隔离公共目录里准备项目页的临时仓库：一个已初始化、一个未初始化、一个普通文件夹，以及一个等着从界面添加的文件夹。
async function fixtures() {
    const home = appEnv.AGENT_ROUTER_HOME!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    const root = path.join(home, 'shots-projects');
    const dir = { initialized: path.join(root, 'initialized'), uninitialized: path.join(root, 'uninitialized'), plain: path.join(root, 'plain'), add: path.join(root, 'to-add'), identity: path.join(root, 'identity'), global: path.join(root, 'identity-global') };
    for (const d of Object.values(dir)) await mkdir(d, { recursive: true });

    for (const d of [dir.initialized, dir.uninitialized]) {
        git(d, ['init', '-b', 'main']);
        git(d, ['config', 'user.name', 'AgentRouter Shots']);
        git(d, ['config', 'user.email', 'shots@example.invalid']);
    }
    await writeFile(path.join(dir.initialized, 'README.md'), '# 已初始化项目\n');
    git(dir.initialized, ['add', '--', 'README.md']);
    git(dir.initialized, ['commit', '-m', '初始提交', '--', 'README.md']);
    await core(['init', dir.initialized]);

    await writeFile(path.join(dir.uninitialized, 'AGENTS.md'), '# 未初始化项目\n\n已有的约定段落，初始化时只在后面追加带标记的段落。\n');
    await writeFile(path.join(dir.uninitialized, 'README.md'), '# 未初始化项目\n');
    git(dir.uninitialized, ['add', '--', 'AGENTS.md', 'README.md']);
    git(dir.uninitialized, ['commit', '-m', '初始提交', '--', 'AGENTS.md', 'README.md']);
    await core(['projects', 'add', dir.uninitialized]);

    // 没有提交身份的仓库：初始提交用一次性的 -c 身份，不写进任何 git 配置（隔离的全局配置也是空的）。
    for (const d of [dir.identity, dir.global]) {
        await writeFile(path.join(d, 'README.md'), '# 没有提交身份的项目\n');
        git(d, ['init', '-b', 'main']);
        git(d, ['add', '--', 'README.md']);
        commitAs(d, '初始提交', ['README.md']);
        await core(['projects', 'add', d]);
    }

    await writeFile(path.join(dir.plain, '说明.txt'), '普通文件夹，不是 git 仓库。\n');
    await core(['projects', 'add', dir.plain, '--allow-non-git']);
    await writeFile(path.join(dir.add, '说明.txt'), '等界面添加的文件夹。\n');
    return dir;
}

export async function captureProjects(h: Harness) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause } = h;
    const dir = await fixtures();
    const home = appEnv.AGENT_ROUTER_HOME!, projectsFile = path.join(home, 'projects.json');
    const readProjects = async () => (JSON.parse(await readFile(projectsFile, 'utf8')).projects as { path: string }[]);
    const config = async (d: string) => JSON.parse(await readFile(path.join(d, '.agent-router', 'project.json'), 'utf8'));
    const until = async (fn: () => boolean, label: string) => {
        if ((await pollUntil(fn, 20000)).ok) return;
        assert.fail(`等待超时：${label}`);
    };
    // 深浅各截一张，然后回到深色。
    const shot = async (name: string) => {
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await h.save(`${name}-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await pause(100);
    };
    // 列表行的路径里可能有反斜杠，不拼属性选择器：按 dataset 找到序号，再给这一行临时标记后用真实鼠标点。
    const pick = async (d: string) => {
        const i = await evaluate(`[...document.querySelectorAll('[data-pj-row]')].findIndex(b => b.dataset.pjRow === ${JSON.stringify(d)})`);
        assert.ok(i >= 0, `项目列表里没有 ${d}`);
        await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-pj-row]')]; rows[${i}].setAttribute('data-pj-pick', ''); return true; })()`);
        await press('[data-pj-row][data-pj-pick]');
        await wait(`document.querySelector('[data-pj-detail] .dh h2')?.textContent === ${JSON.stringify(path.basename(d))} && document.querySelector('[data-pj-row].on')?.dataset.pjRow === ${JSON.stringify(d)}`, `选中项目 ${path.basename(d)}`);
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

    // 从任务页出发，先验证侧栏的"配置"分组、键盘切换与执行者负载。
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task=t1]")');
    await check('UI15 侧栏"配置"分组下依次是"项目""Agent"', `(() => { const g = [...document.querySelectorAll('.nav-group')].find(x => x.textContent === '配置'); if (!g) return false; const project = g.nextElementSibling, agent = project?.nextElementSibling; return project?.dataset.page === 'projects' && project.textContent.trim() === '项目' && agent?.dataset.page === 'connect' && agent.textContent.trim() === 'Agent'; })()`);
    await check('UI15 执行者负载按显示名统计正在运行的任务', `document.querySelector('.nav-foot .mono')?.textContent === 'Codex 2' && document.querySelector('.nav-foot div[title]')?.title === '正在运行的任务数（按执行者）'`);
    await tabTo('[data-page=projects]');
    await focusRing('UI15 侧栏「项目」');
    await key('Enter');
    await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '键盘进入项目页');
    await check('UI15 键盘 Tab 到"项目"按 Enter 切换页面并高亮', `document.querySelector('[data-page=projects]').getAttribute('aria-current') === 'page'`);

    // 添加：桩返回预先准备好的文件夹；队列空了返回 null，相当于用户取消。
    const beforeAdd = (await readProjects()).length, requested = effects.folderRequests;
    effects.folders.push(dir.add);
    await press('.page-h [data-pj=add]');
    await wait(`document.querySelectorAll('[data-pj-row]').length === ${beforeAdd + 1} && document.querySelector('[data-pj-row].on')?.dataset.pjRow === ${JSON.stringify(dir.add)}`, '添加项目后出现在列表并被选中', 20000);
    await verify('UI15 添加项目：桩返回的文件夹登记进 projects.json，folderRequests 增加一次', async () => {
        assert.ok((await readProjects()).some(p => p.path === dir.add));
        assert.equal(effects.folderRequests, requested + 1);
    });
    await check('UI15 添加的项目出现在列表并被选中', `document.querySelector('[data-pj-row].on')?.dataset.pjRow === ${JSON.stringify(dir.add)} && document.querySelector('[data-pj-detail] .dh h2')?.textContent === 'to-add'`);
    const afterAdd = (await readProjects()).length, requested2 = effects.folderRequests;
    await press('.page-h [data-pj=add]');
    await wait('!document.querySelector(".page-h [data-pj=add]").disabled', '取消选择后按钮恢复');
    await verify('UI15 选择文件夹返回 null（取消）时不添加项目', async () => {
        assert.equal(effects.folderRequests, requested2 + 1);
        assert.equal((await readProjects()).length, afterAdd);
    });

    // 非 git：横幅 + 一键 git init。
    await pick(dir.add);
    await wait('!!document.querySelector(".banner.info [data-pj=git-init]")');
    await check('UI15 非 git 文件夹显示信息横幅与"初始化为 git 仓库"主按钮', `document.querySelector('.banner.info .rt b')?.textContent === '这个文件夹不是 git 仓库' && document.querySelector('.banner.info [data-pj=git-init]')?.classList.contains('primary')`);
    await shot('projects-nongit');
    await press('[data-pj=git-init]');
    await wait('!!document.querySelector(".banner.brand [data-pj=init]")', 'git init 后变成未初始化', 30000);
    await verify('UI15 点"初始化为 git 仓库"后文件夹里真的有 .git', async () => { assert.ok(await exists(path.join(dir.add, '.git'))); });
    await check('UI15 git init 后详情变成"未初始化"，列表标签跟着变', `!!document.querySelector('.banner.brand') && [...document.querySelectorAll('[data-pj-row]')].find(b => b.dataset.pjRow === ${JSON.stringify(dir.add)})?.textContent.includes('未初始化')`);

    // 初始化：预览（新建 7 · 更新 1）→ 展开 → 取消不写 → 写入 → 提交。
    await pick(dir.uninitialized);
    await wait('!!document.querySelector(".banner.brand [data-pj=init]")');
    await shot('projects-uninitialized');
    await press('[data-pj=init]');
    await wait('!!document.querySelector("[data-pj-init]")');
    await check('UI15 初始化预览：新建 7、更新 1，计数写进说明', `(() => { const tags = [...document.querySelectorAll('.initlist .tag')].map(t => t.textContent); return tags.filter(x => x === '新建').length === 7 && tags.filter(x => x === '更新').length === 1 && document.querySelector('.sec-t').textContent.includes('新建 7 · 更新 1'); })()`);
    await press('[data-pj-init]');
    await check('UI15 展开初始化项后能看到内容，aria-expanded 同步', `document.querySelector('[data-pj-init][aria-expanded=true]') !== null && (document.querySelector('[data-pj-preview]')?.textContent.length ?? 0) > 20`);
    await shot('projects-plan');
    const agentsBefore = await readFile(path.join(dir.uninitialized, 'AGENTS.md'), 'utf8');
    await press('[data-pj=plan-cancel]');
    await wait('!!document.querySelector(".banner.brand [data-pj=init]")');
    await verify('UI15 取消初始化不写任何文件', async () => {
        assert.equal(await exists(path.join(dir.uninitialized, '.agent-router', 'project.json')), false);
        assert.equal(await readFile(path.join(dir.uninitialized, 'AGENTS.md'), 'utf8'), agentsBefore);
    });
    await press('[data-pj=init]');
    await wait('!!document.querySelector("[data-pj=apply]")');
    await press('[data-pj=apply]');
    await wait('!!document.querySelector("[data-pj=commit]")', '初始化写入完成', 30000);
    await verify('UI15 确认写入后临时仓库里真的生成了模板文件', async () => {
        for (const rel of ['.agent-router/project.json', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/worker.md', 'docs/roles/reviewer.md', 'docs/specs/README.md', '.gitignore'])
            assert.ok(await exists(path.join(dir.uninitialized, rel)), `缺少 ${rel}`);
    });
    await check('UI15 写入成功后显示成功横幅、文件清单与提交按钮', `document.querySelector('.banner.ok .rt b')?.textContent === '已写入 8 个文件' && document.querySelectorAll('.rows .r').length === 8 && !!document.querySelector('[data-pj=commit]')`);
    await shot('projects-written');
    await writeFile(path.join(dir.uninitialized, 'notes-draft.txt'), '无关改动\n');
    const headBefore = git(dir.uninitialized, ['rev-parse', 'HEAD']);
    await press('[data-pj=commit]');
    await wait('!!document.querySelector("[data-pj-committed]") && document.querySelector("[data-pj-committed]").dataset.pjCommitted?.length >= 7', '提交完成', 30000);
    await verify('UI15 提交后临时仓库多了一个提交，提交里只有清单中的文件，无关文件没进去', async () => {
        assert.notEqual(git(dir.uninitialized, ['rev-parse', 'HEAD']), headBefore);
        const files = git(dir.uninitialized, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort();
        assert.deepEqual(files, ['.agent-router/project.json', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/reviewer.md', 'docs/roles/worker.md', 'docs/specs/README.md']);
        assert.match(git(dir.uninitialized, ['status', '--porcelain', '--', 'notes-draft.txt']), /^\?\?/);
    });
    await check('UI15 提交后按钮处显示已提交的短哈希', `document.querySelector('[data-pj-committed]').dataset.pjCommitted === ${JSON.stringify(git(dir.uninitialized, ['rev-parse', '--short', 'HEAD']))}`);
    await wait('!document.querySelector("[data-pj-committed]") && !!document.querySelector("[data-pj=edit]")', '两秒后刷新回配置视图', 6000);
    await check('UI15 提交结果两秒后刷新回已初始化视图', `!!document.querySelector('[data-pj=edit]') && document.querySelector('.sec-t')?.textContent.includes('项目配置')`);

    // 已初始化：配置行、最近任务、编辑配置模态框。
    await pick(dir.initialized);
    await wait('!!document.querySelector("[data-pj=edit]")');
    await check('UI15 已初始化项目显示配置各行与最近任务', `document.querySelector('.sec-t')?.textContent.includes('项目配置') && document.querySelectorAll('.rows .r').length >= 5 && document.querySelector('.rows .r .v .mono')?.textContent === 'main'`);
    await shot('projects-initialized');
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=baseBranch]")');
    await check('UI15 编辑配置预填当前值', `document.querySelector('[data-pj-f=baseBranch]').value === 'main' && document.querySelector('[data-pj-f=specsDir]').value === 'docs/specs'`);
    await shot('projects-edit');
    await press('[data-pj-f=verify]');
    await key('a', ['control']);
    await key('Backspace');
    await type('[data-pj-f=verify]', 'npm run test:shots');
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet")');
    await verify('UI15 改验收命令保存后 project.json 的 verify 变了，且只写改过的键', async () => {
        const c = await config(dir.initialized);
        assert.deepEqual(c.verify, ['npm run test:shots']);
        assert.deepEqual(c.allowedPaths, ['**']);
        assert.equal(c.specsDir, 'docs/specs');
    });
    // 041：保存后刷新还在进行时立即点"编辑配置"，点击不能被静默丢掉：对话框要打开，字段是刚保存的新值。
    // 配合 AR_SHOTS_EXPERIMENT=projects-show-delay 可以确定性地让这次点击落在刷新窗口里（见汇报）。
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=verify]")', '保存后立即点"编辑配置"能打开');
    await check('UI15 保存后刷新期间点"编辑配置"能打开，字段是刚保存的新值', `document.querySelector('[data-pj-f=verify]').value === 'npm run test:shots'`);
    await key('Escape');
    await wait('!document.querySelector(".sheet")', '关闭刚打开的编辑配置');
    const beforeInvalid = await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8');
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=specsDir]")');
    await press('[data-pj-f=specsDir]');
    await key('a', ['control']);
    await key('Backspace');
    await type('[data-pj-f=specsDir]', '../x');
    await press('.sheet-btns .btn:last-child');
    await wait('!!document.querySelector(".sheet .banner.fail")');
    await check('UI15 非法任务说明目录：模态框顶部显示原因且保持打开', `!!document.querySelector('.sheet') && document.querySelector('.sheet .banner.fail').textContent.includes('specsDir')`);
    await verify('UI15 非法任务说明目录不改 project.json', async () => {
        assert.equal(await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8'), beforeInvalid);
    });
    await key('Escape');
    await wait('!!document.querySelector(".confirm-overlay")');
    await check('UI15 有未保存改动时 Esc 先确认放弃', `document.querySelector('.confirm-card h2')?.textContent === '放弃未保存的改动？'`);
    await press('.confirm-actions .danger');
    await wait('!document.querySelector(".sheet") && !document.querySelector(".confirm-overlay")');
    await verify('UI15 放弃改动后关闭模态框，文件仍然不变', async () => {
        assert.equal(await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8'), beforeInvalid);
    });

    // UI18 打开 Claude Code / 文件夹：两个按钮键盘可达，调用参数正确。
    await wait('!!document.querySelector("[data-pj=claude]") && !!document.querySelector("[data-pj=folder]")');
    const launched = effects.launched.length, opened = effects.opened.length, cwd = dir.initialized;
    await tabTo('[data-pj=claude]');
    await focusRing('UI18 在此项目打开 Claude Code');
    await key('Enter');
    await until(() => effects.launched.length > launched, '打开 Claude Code 的调用');
    await verify('UI18 打开 Claude Code：cwd 与参数里的目录是项目绝对路径，参数以 claude 结尾', () => {
        const last = effects.launched.at(-1)!;
        assert.equal(effects.launched.length, launched + 1);
        assert.equal(last.cwd, cwd);
        assert.ok(last.args.includes(cwd), `参数里没有项目目录：${last.args.join(' ')}`);
        assert.equal(last.args.at(-1), 'claude');
    });
    await tabTo('[data-pj=folder]');
    await focusRing('UI18 打开文件夹');
    await key('Enter');
    await until(() => effects.opened.length > opened, '打开文件夹的调用');
    await verify('UI18 打开文件夹：桩记录的最后一条是项目路径', () => {
        assert.equal(effects.opened.length, opened + 1);
        assert.equal(effects.opened.at(-1), cwd);
    });

    // 提交身份：没有身份时的状态行、横幅、提交失败指引、模态框校验与保存（只用于这个项目），以及全局作用域。
    await pick(dir.identity);
    await wait('!!document.querySelector(".banner.brand [data-pj=identity]") && !!document.querySelector(".banner.brand [data-pj=init]")', '没有提交身份时两个横幅都显示');
    await check('UI15 没有提交身份：状态行显示"未设置"，身份横幅在初始化横幅之前', `(() => { const items = [...document.querySelectorAll('.dh-2 .ident')]; const banners = [...document.querySelectorAll('.pj-body > .banner.brand')]; return items.length === 1 && items[0].textContent.includes('提交身份') && items[0].textContent.includes('未设置') && banners.length === 2 && banners[0].textContent.includes('还没有设置 git 提交身份') && banners[1].textContent.includes('还没有初始化'); })()`);
    await shot('projects-identity-missing');
    await press('[data-pj=init]');
    await wait('!!document.querySelector("[data-pj=apply]")');
    await press('[data-pj=apply]');
    await wait('!!document.querySelector("[data-pj=commit]")', '没有身份的项目写入初始化文件', 30000);
    const identityHead = git(dir.identity, ['rev-parse', 'HEAD']);
    await press('[data-pj=commit]');
    await wait('!!document.querySelector(".banner.fail [data-pj=identity]")', '提交失败：没有提交身份', 30000);
    await check('UI15 "提交这些文件"没有身份时显示核心说明与"设置提交身份…"按钮', `(() => { const b = document.querySelector('.banner.fail'); return b.textContent.includes('还没有设置 git 提交身份') && b.querySelector('[data-pj=identity]') !== null; })()`);
    await verify('UI15 没有提交身份时不产生提交', async () => { assert.equal(git(dir.identity, ['rev-parse', 'HEAD']), identityHead); });

    await press('.banner.fail [data-pj=identity]');
    await wait('!!document.querySelector(".sheet [data-id-f=name]")');
    await check('UI15 设置身份模态框默认"只用于这个项目"并说明写入 .git/config', `document.querySelector('[data-id-scope=repo]')?.classList.contains('on') && document.querySelector('[data-id-scope=repo]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet-f .note')?.textContent.includes('这个项目的 .git/config')`);
    await press('.sheet-btns .btn:last-child');
    await wait('!!document.querySelector("[data-id-error=name]")?.textContent', '空用户名提示');
    await check('UI15 空用户名与坏邮箱：字段下显示提示', `document.querySelector('[data-id-error=name]').textContent === '请填写用户名' && document.querySelector('[data-id-error=email]').textContent === '邮箱格式不对'`);
    await verify('UI15 校验不通过时不写 git 配置', () => {
        assert.notEqual(gitStatus(dir.identity, ['config', '--get', 'user.name']).status, 0);
        assert.notEqual(gitStatus(dir.identity, ['config', '--get', 'user.email']).status, 0);
    });
    await typeIn('[data-id-f=name]', 'AgentRouter Identity');
    await typeIn('[data-id-f=email]', 'not-an-email');
    await press('.sheet-btns .btn:last-child');
    await check('UI15 坏邮箱：只在邮箱字段下提示', `document.querySelector('[data-id-error=email]').textContent === '邮箱格式不对' && document.querySelector('[data-id-error=name]').textContent === ''`);
    await focusField('[data-id-f=email]');
    await key('a', ['control']);
    await key('Backspace');
    await typeIn('[data-id-f=email]', 'identity@example.invalid');
    await shot('projects-identity');
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet") && !document.querySelector(".banner.fail") && !document.querySelector("[data-pj=identity]")', '保存提交身份后刷新');
    await verify('UI15 保存（只用于这个项目）：写进仓库 .git/config，隔离的全局配置没变', async () => {
        assert.equal(git(dir.identity, ['config', '--local', '--get', 'user.name']), 'AgentRouter Identity');
        assert.equal(git(dir.identity, ['config', '--local', '--get', 'user.email']), 'identity@example.invalid');
        assert.ok(!(await readFile(path.join(home, 'gitconfig'), 'utf8')).includes('identity@example.invalid'));
    });
    await check('UI15 保存后身份横幅消失，状态行显示"用户名 <邮箱>"', `!document.querySelector('[data-pj=identity]') && document.querySelector('.dh-2 .ident')?.textContent.includes('AgentRouter Identity <identity@example.invalid>')`);
    await press('[data-pj=commit]');
    await wait('!!document.querySelector("[data-pj-committed]")', '补好身份后提交成功', 30000);
    await verify('UI15 补好身份后"提交这些文件"真正产生提交', async () => {
        assert.notEqual(git(dir.identity, ['rev-parse', 'HEAD']), identityHead);
        assert.ok(git(dir.identity, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').includes('.agent-router/project.json'));
    });

    // 模态框键盘：Tab 在框内循环；未改动时 Esc 关闭并把焦点放回触发按钮。
    await pick(dir.global);
    await wait('!!document.querySelector(".banner.brand [data-pj=identity]")');
    await press('[data-pj=identity]');
    await wait('!!document.querySelector(".sheet [data-id-f=name]")');
    // 焦点在下一帧才落到用户名，等它到位再断言。
    await wait('document.activeElement === document.querySelector("[data-id-f=name]")', '打开设置身份模态框后焦点在用户名');
    await check('UI15 打开设置身份模态框后焦点在用户名', `document.activeElement === document.querySelector('[data-id-f=name]')`);
    await tabTo('[data-id-scope=global]');
    await check('UI15 Tab 能到达"本机所有项目"分段', `document.activeElement === document.querySelector('[data-id-scope=global]')`);
    for (let i = 0; i < 10; i++) await key('Tab');
    await check('UI15 Tab 在模态框内循环，焦点不会跑到背景', `document.activeElement?.closest('.sheet') !== null`);
    await key('Escape');
    await wait('!document.querySelector(".sheet")', 'Esc 关闭设置身份模态框');
    await check('UI15 Esc 关闭后焦点回到"设置提交身份…"按钮', `document.activeElement === document.querySelector('[data-pj=identity]')`);

    // 全局作用域：写进隔离的全局配置文件；仓库自己的 .git/config 不写。测完清空，避免影响后面的页面。
    const globalConfig = path.join(home, 'gitconfig');
    await press('[data-pj=identity]');
    await wait('!!document.querySelector(".sheet [data-id-f=name]")');
    await typeIn('[data-id-f=name]', 'AgentRouter Global');
    await typeIn('[data-id-f=email]', 'global@example.invalid');
    await press('[data-id-scope=global]');
    await check('UI15 选"本机所有项目"时底栏说明改为全局配置', `document.querySelector('[data-id-scope=global]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet-f .note').textContent.includes('全局 git 配置')`);
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet") && !document.querySelector(".banner.brand [data-pj=identity]")', '全局身份保存后横幅消失');
    await verify('UI15 选"本机所有项目"：写进隔离的全局配置，仓库本地配置不写', async () => {
        assert.match(await readFile(globalConfig, 'utf8'), /global@example\.invalid/);
        assert.notEqual(gitStatus(dir.global, ['config', '--local', '--get', 'user.email']).status, 0);
    });
    await check('UI15 全局身份保存后状态行显示"用户名 <邮箱>"', `document.querySelector('.dh-2 .ident')?.textContent.includes('AgentRouter Global <global@example.invalid>')`);
    // 清空隔离的全局配置：后面新建任务页要能稳定复现"没有提交身份"。
    await writeFile(globalConfig, '');

    // 移除：确认框默认焦点在取消；取消不改，确认后只移出列表，不删文件夹。
    await pick(dir.add);
    await wait('!!document.querySelector("[data-pj=more]")');
    const beforeRemove = (await readProjects()).length;
    await press('[data-pj=more]');
    await press('.ctx button:nth-child(2)');
    await wait('!!document.querySelector(".confirm-overlay")');
    await check('UI15 移除确认默认焦点在取消，确认按钮是危险按钮', `document.activeElement.textContent === '取消' && !!document.querySelector('.confirm-actions .danger')`);
    await press('.confirm-actions .btn');
    await wait('!document.querySelector(".confirm-overlay")');
    await verify('UI15 取消移除不改 projects.json', async () => { assert.equal((await readProjects()).length, beforeRemove); });
    await press('[data-pj=more]');
    await press('.ctx button:nth-child(2)');
    await press('.confirm-actions .danger');
    await wait(`document.querySelectorAll('[data-pj-row]').length === ${beforeRemove - 1}`, '确认移除后列表少一项');
    await verify('UI15 确认移除：projects.json 里没有它，磁盘上的文件夹还在', async () => {
        assert.equal((await readProjects()).some(p => p.path === dir.add), false);
        assert.ok(await exists(dir.add));
        assert.ok(await exists(path.join(dir.add, '.git')));
    });

    // 空状态：临时清空 projects.json，截完恢复。
    const original = await readFile(projectsFile, 'utf8');
    await press('[data-page=tasks]');
    await writeFile(projectsFile, JSON.stringify({ v: 1, projects: [] }, null, 2) + '\n');
    try {
        await press('[data-page=projects]');
        await wait('!!document.querySelector(".empty.tall") && !!document.querySelector("[data-pj=add]")');
        await check('UI15 空状态：说明文字 + 主按钮"添加第一个项目"', `document.querySelector('.empty.tall b')?.textContent === '还没有添加项目' && document.querySelector('.empty.tall [data-pj=add]')?.classList.contains('primary')`);
        await shot('projects-empty');
    }
    finally {
        await press('[data-page=tasks]');
        await writeFile(projectsFile, original);
        await press('[data-page=projects]');
        await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '恢复项目列表');
    }
}
