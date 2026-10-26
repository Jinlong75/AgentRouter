import { pollUntil } from './shots-input';
import { readFile, writeFile, appendFile, mkdir, stat, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserWindow, nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import { effects } from './effects';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { pj, s6 } from '../shared/copy';

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
    // 改写：侧栏底部改成“每个执行者一行：显示名 + 运行数/上限”（原来是单行“Codex 2”，悬停“正在运行的任务数（按执行者）”）。
    await check('UI15 执行者负载按显示名统计正在运行的任务', `[...document.querySelectorAll('.nav-foot .load-l')].some(r => r.firstElementChild.textContent === 'Codex' && r.lastElementChild.textContent === ${JSON.stringify(s6.loadRow(2, 2))} && r.title === ${JSON.stringify(s6.loadTip('Codex', 2, 2))})`);
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
    await check('UI15 提交结果两秒后刷新回已初始化视图', `!!document.querySelector('[data-pj=edit]') && [...document.querySelectorAll('.sec-t')].some(x => x.textContent.includes('项目配置'))`);

    // 130 更新协作约定：把刚初始化并提交的仓库改成 Stage05 时期的旧样子（worker 是旧内容、缺 reviewer、配置没有 worktree / setup），再走完预览 → 确认 → 提交 → 再看。
    const legacyWorker = '# 角色：执行者\n\n旧版本的说明\n\n## 硬规则\n\n- 旧规则一\n';
    const legacyConfig = (await readFile(path.join(dir.uninitialized, '.agent-router', 'project.json'), 'utf8')).replace(/,\n  "setup": \[\]/, '').replace(/,\n  "worktree": true/, '');
    assert.ok(!legacyConfig.includes('"worktree"') && !legacyConfig.includes('"setup"'), '旧配置夹具没做成');
    await writeFile(path.join(dir.uninitialized, 'docs', 'roles', 'worker.md'), legacyWorker);
    await writeFile(path.join(dir.uninitialized, '.agent-router', 'project.json'), legacyConfig);
    await rm(path.join(dir.uninitialized, 'docs', 'roles', 'reviewer.md'));
    await pick(dir.initialized);
    await pick(dir.uninitialized);
    await wait('!!document.querySelector("[data-pj=upgrade]")');
    await check('UI15 130 已初始化项目的"项目配置"标题旁有次按钮"更新协作约定…"，在"编辑配置"左边', `(() => { const b = document.querySelector('[data-pj=upgrade]'); return b?.textContent.trim() === ${JSON.stringify(pj.upgradeOpen)} && b.classList.contains('quiet') && b.nextElementSibling === document.querySelector('[data-pj=edit]'); })()`);
    await press('[data-pj=upgrade]');
    await wait('!!document.querySelector("[data-pj=upgrade-apply]")', '更新协作约定预览', 30000);
    await check('UI15 130 预览：新建 reviewer.md、角色差异 worker.md（默认保留）、配置新字段 worktree 与 setup 默认不勾', `(() => { const tags = [...document.querySelectorAll('.initlist .tag')].map(t => t.textContent); return tags.includes(${JSON.stringify(pj.kindAdd)}) && [...document.querySelectorAll('.initlist code')].some(x => x.textContent === 'docs/roles/reviewer.md') && tags.includes(${JSON.stringify(pj.roleDiffTag)}) && document.querySelector('[data-pj-role-set=worker][data-pj-v=keep]')?.classList.contains('on') && !document.querySelector('[data-pj-role-set=worker][data-pj-v=replace]').classList.contains('on') && !document.querySelector('[data-pj-role-set=lead]') && document.querySelector('[data-pj-field=worktree]')?.getAttribute('aria-checked') === 'false' && document.querySelector('[data-pj-field=setup]')?.getAttribute('aria-checked') === 'false' && document.querySelector('.pj-body .sec-t').textContent.includes('AgentRouter') && document.querySelector('.inline-f .note')?.textContent.includes('还没有写入任何文件'); })()`);
    await press('[data-pj-role-open=worker]');
    await check('UI15 130 展开角色差异：有 + 行和 − 行', `document.querySelector('[data-pj-role-open=worker]').getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-pj-diff=worker] .dl.add') && [...document.querySelectorAll('[data-pj-diff=worker] .dl.del .code')].some(x => x.textContent === '- 旧规则一')`);
    await shot('projects-upgrade');
    await press('[data-pj-role-set=worker][data-pj-v=replace]');
    await press('[data-pj-field=worktree]');
    await press('[data-pj-field=setup]');
    await check('UI15 130 切到"备份后替换"并勾选字段后，说明里的备份数与文件数同步', `document.querySelector('[data-pj-role-set=worker][data-pj-v=replace]').classList.contains('on') && document.querySelector('[data-pj-field=worktree]').getAttribute('aria-checked') === 'true' && document.querySelector('.inline-f .note').textContent === ${JSON.stringify(pj.upgradeNote(4, 1))}`);
    await verify('UI15 130 确认前不写任何文件', async () => {
        assert.equal(await readFile(path.join(dir.uninitialized, 'docs', 'roles', 'worker.md'), 'utf8'), legacyWorker);
        assert.equal(await exists(path.join(dir.uninitialized, 'docs', 'roles', 'reviewer.md')), false);
    });
    await press('[data-pj=upgrade-apply]');
    await wait('!!document.querySelector("[data-pj=commit]")', '更新协作约定写入完成', 30000);
    await verify('UI15 130 确认写入后：worker 换成模板、备份等于旧内容、project.json 多了两个字段、.gitignore 忽略备份、reviewer 补上', async () => {
        const worker = await readFile(path.join(dir.uninitialized, 'docs', 'roles', 'worker.md'), 'utf8');
        assert.notEqual(worker, legacyWorker); assert.match(worker, /^# 角色：执行者/);
        const backups = (await readdir(path.join(dir.uninitialized, '.agent-router', 'backup'))).filter(n => n.startsWith('worker.md-'));
        assert.equal(backups.length, 1);
        assert.equal(await readFile(path.join(dir.uninitialized, '.agent-router', 'backup', backups[0]), 'utf8'), legacyWorker);
        const cfg = await config(dir.uninitialized);
        assert.equal(cfg.worktree, true); assert.deepEqual(cfg.setup, []);
        assert.ok((await readFile(path.join(dir.uninitialized, '.gitignore'), 'utf8')).split('\n').includes('.agent-router/backup/'));
        assert.ok(await exists(path.join(dir.uninitialized, 'docs', 'roles', 'reviewer.md')));
    });
    await check('UI15 130 写入后显示 pj.upgradeDone 与"提交这些文件"', `document.querySelector('.banner.ok .rt b')?.textContent === ${JSON.stringify(pj.upgradeDone(4, 1))} && !!document.querySelector('[data-pj=commit]')`);
    await press('[data-pj=commit]');
    await wait('!!document.querySelector("[data-pj-committed]") && document.querySelector("[data-pj-committed]").dataset.pjCommitted?.length >= 7', '更新协作约定提交完成', 30000);
    await verify('UI15 130 提交里没有备份文件，工作区也看不到备份', async () => {
        const files = git(dir.uninitialized, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort();
        assert.deepEqual(files, ['.agent-router/project.json', '.gitignore']);  // worker.md、reviewer.md 最后的内容和已提交的模板一样，没有改动
        assert.equal(git(dir.uninitialized, ['status', '--porcelain', '-uall', '--', '.agent-router']), '');
    });
    await wait('!document.querySelector("[data-pj-committed]") && !!document.querySelector("[data-pj=upgrade]")', '两秒后刷新回配置视图', 6000);
    await press('[data-pj=upgrade]');
    await wait('!!document.querySelector(".pj-body [data-pj=plan-cancel]")', '再次预览');
    await check('UI15 130 再点"更新协作约定…"：没有可更新项，只显示 pj.planNone', `document.querySelector('.pj-body .sec-t')?.textContent === ${JSON.stringify(pj.planNone)} && !document.querySelector('[data-pj=upgrade-apply]') && !document.querySelector('.rolehead')`);
    await press('[data-pj=plan-cancel]');
    await wait('!!document.querySelector("[data-pj=edit]")');

    // 已初始化：配置行、最近任务、编辑配置模态框。
    await pick(dir.initialized);
    await wait('!!document.querySelector("[data-pj=edit]")');
    await check('UI15 已初始化项目显示配置各行与最近任务', `[...document.querySelectorAll('.sec-t')].some(x => x.textContent.includes('项目配置')) && document.querySelectorAll('.rows .r').length >= 5 && document.querySelector('.rows .r .v .mono')?.textContent === 'main'`);
    // 132 新增：按界面稿，"远程"一节在"项目配置"上面（原来第一个 .sec-t 就是项目配置，上面三条已改成在所有 .sec-t 里找它）。没有远程的项目只有一行说明，没有任何按钮。
    await check('UI15 132 新增：远程一节在项目配置之上；没有远程时只有一行说明 pj.remoteNone，没有刷新 / 推送 / 拉取按钮', `(() => { const titles = [...document.querySelectorAll('.sec-t')]; const remote = titles.findIndex(x => x.textContent.trim() === ${JSON.stringify(pj.remoteSec)}); const config = titles.findIndex(x => x.textContent.includes('项目配置')); const box = document.querySelector('[data-pj-remote=none]'); return remote === 0 && config > remote && !!box && box.textContent.trim() === ${JSON.stringify(pj.remoteNone)} && box.querySelectorAll('.r').length === 1 && !document.querySelector('[data-pj^=remote]'); })()`);
    await shot('projects-initialized');
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=baseBranch]")');
    await check('UI15 编辑配置预填当前值', `document.querySelector('[data-pj-f=baseBranch]').value === 'main' && document.querySelector('[data-pj-f=specsDir]').value === 'docs/specs'`);
    // 132 新增：主分支等字段之后有"推送"小节：远程输入框（留空 = origin）和两个勾选项，默认都不勾。
    await check('UI15 132 新增：编辑配置在“推送”小节里有远程输入框与两个勾选项（批准合并后自动推送、允许主导推送），默认都不勾', `(() => { const f = document.querySelector('.sheet [data-pj-f="push.remote"]'); const boxes = [...document.querySelectorAll('.sheet [data-pj-c]')]; const sec = [...document.querySelectorAll('.sheet .sec-t')].find(x => x.textContent === ${JSON.stringify(pj.pushSec)}); const later = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); return !!f && f.value === '' && f.placeholder === 'origin' && boxes.map(b => b.dataset.pjC).join() === 'afterAccept,allowLead' && boxes.every(b => b.getAttribute('aria-checked') === 'false') && boxes[0].textContent.includes(${JSON.stringify(pj.pushAfterAccept)}) && boxes[1].textContent.includes(${JSON.stringify(pj.pushAllowLead)}) && !!sec && later(document.querySelector('.sheet [data-pj-f=specsDir]'), sec) && later(sec, f); })()`);
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

    // ---- Stage07b 126：编辑配置的"高级"区（真实输入）----
    // 核心模板的 project.json 自带 "worktree": true；高级区没动过 worktree 时它必须保持原值。
    const worktreeBefore = (await config(dir.initialized)).worktree;
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-fold]")');
    await check('UI15 126 新增：编辑配置底部有“高级”折叠标题，默认折叠，四项不可见', `(() => { const f = document.querySelector('.sheet [data-pj-fold]'); const body = document.querySelector('.sheet [data-pj-adv]'); return f.textContent.trim() === ${JSON.stringify(pj.advanced)} && f.getAttribute('aria-expanded') === 'false' && body.hidden && body.offsetHeight === 0; })()`);
    await tabTo('[data-pj-fold]');
    await key('Enter');
    await wait(`document.querySelector('.sheet [data-pj-fold]').getAttribute('aria-expanded') === 'true' && document.querySelector('.sheet [data-pj-adv]').offsetHeight > 0`, '按回车展开高级');
    await check('UI15 126 新增：回车展开后四行齐全：重试次数与超时占位为默认值，合并方式选中 no-ff，worktree 开关为开', `(() => { const r = document.querySelector('.sheet [data-pj-f=maxRetries]'), t = document.querySelector('.sheet [data-pj-f=verifyTimeoutMin]'); const on = document.querySelector('.sheet [data-pj-merge].on'); const wt = document.querySelector('.sheet [data-pj-wt]'); return r.value === '' && r.placeholder === ${JSON.stringify(pj.advDefault('2'))} && t.value === '' && t.placeholder === ${JSON.stringify(pj.advDefault('10'))} && on.dataset.pjMerge === 'no-ff' && wt.getAttribute('aria-checked') === 'true' && [...document.querySelectorAll('.sheet [data-pj-adv] .fl b')].map(x => x.textContent).join() === ${JSON.stringify(['maxRetries', 'mergeMode', 'verifyTimeoutMin', 'worktree'].map(k => pj.advFields[k]).join())}; })()`);
    await shot('projects-edit-advanced');
    await press('[data-pj-f=maxRetries]');
    await type('[data-pj-f=maxRetries]', '1');
    await press('[data-pj-merge=squash]');
    await check('UI15 126 新增：点“压成一个提交”后它被选中', `document.querySelector('.sheet [data-pj-merge].on').dataset.pjMerge === 'squash'`);
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet")');
    await verify('UI15 126 新增：保存后 project.json 有 maxRetries: 1、mergeMode: "squash"，没动的高级项不出现，其余不变', async () => {
        const c = await config(dir.initialized);
        assert.strictEqual(c.maxRetries, 1);
        assert.strictEqual(c.mergeMode, 'squash');
        assert.equal('verifyTimeoutMin' in c, false);
        assert.equal(c.worktree, worktreeBefore, 'worktree 没动过，保持模板里的原值');
        assert.deepEqual(c.verify, ['npm run test:shots']);
        assert.equal(c.specsDir, 'docs/specs');
    });
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=maxRetries]")');
    await check('UI15 126 新增：再打开时“高级”自动展开，值是 1 与 squash', `(() => { const f = document.querySelector('.sheet [data-pj-fold]'); return f.getAttribute('aria-expanded') === 'true' && document.querySelector('.sheet [data-pj-adv]').offsetHeight > 0 && document.querySelector('.sheet [data-pj-f=maxRetries]').value === '1' && document.querySelector('.sheet [data-pj-merge].on').dataset.pjMerge === 'squash' && document.querySelector('.sheet [data-pj-f=verifyTimeoutMin]').value === ''; })()`);
    // 核心拒绝：9 超出 0～5。原因显示在字段下面，弹窗不关，文件不变。
    const beforeAdv = await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8');
    await press('[data-pj-f=maxRetries]');
    await key('a', ['control']);
    await key('Backspace');
    await type('[data-pj-f=maxRetries]', '9');
    await press('.sheet-btns .btn:last-child');
    await wait('!!document.querySelector(".sheet [data-pj-err=maxRetries]")?.textContent');
    await check('UI15 126 新增：输入 9 保存，核心原因显示在自动重试次数字段下面，弹窗保持打开', `(() => { const e = document.querySelector('.sheet [data-pj-err=maxRetries]'); return !!document.querySelector('.sheet') && e.textContent.includes('maxRetries') && e.textContent.includes('0～5') && e.closest('.fld').querySelector('[data-pj-f=maxRetries]') !== null; })()`);
    await verify('UI15 126 新增：被拒绝时 project.json 一个字节不变', async () => {
        assert.equal(await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8'), beforeAdv);
    });
    // 清空：maxRetries 被删掉（null 传给核心），其余高级项保持。
    await press('[data-pj-f=maxRetries]');
    await key('a', ['control']);
    await key('Backspace');
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet")');
    await verify('UI15 126 新增：清空自动重试次数保存后 maxRetries 被删掉，mergeMode 仍是 squash', async () => {
        const c = await config(dir.initialized);
        assert.equal('maxRetries' in c, false);
        assert.strictEqual(c.mergeMode, 'squash');
        assert.equal('verifyTimeoutMin' in c, false);
        assert.equal(c.worktree, worktreeBefore);
        assert.deepEqual(c.verify, ['npm run test:shots']);
    });

    // 095（D41）git 版本检查：核心把 AR_TEST_GIT_VERSION 当作 `git --version` 的输出，用它让核心报告旧版本。
    // 软件每次调用核心都从主进程的 process.env 重新取环境（appEnvironment(process.env)），所以只在这一项检查里设置、查完删除。
    // 离开项目页再回来触发重新读取；横幅只是提示，不禁用任何按钮。
    const reopenProjects = async () => {
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task=t1]")', '回到任务页');
        await press('[data-page=projects]');
        await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '重新进入项目页');
        await pick(dir.initialized);
        await wait('!!document.querySelector("[data-pj=edit]")', '已初始化项目的详情');
    };
    process.env.AR_TEST_GIT_VERSION = 'git version 2.39.1.windows.1';
    try {
        await reopenProjects();
        await wait(`!!document.querySelector('.pj-body > .banner.brand .rt b') && document.querySelector('.pj-body > .banner.brand .rt b').textContent === 'git 版本太旧：2.39.1'`, 'git 版本太旧的横幅出现');
        await check('UI15 git 低于 2.40：项目详情顶部（项目配置之上）显示横幅"git 版本太旧：2.39.1"', `(() => { const b = document.querySelector('.pj-body > .banner.brand'); return !!b && b.querySelector('.rt b').textContent === 'git 版本太旧：2.39.1' && b.querySelector('.rt span').textContent.includes('git 2.40 或更新') && b === document.querySelector('.pj-body').firstElementChild && !!(b.compareDocumentPosition(document.querySelector('.pj-body .sec-t')) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
        // 132 新增：插入"远程"一节后，上面那条断言（横幅在最上面、在项目配置之上）仍成立；这里再钉死三者的顺序。
        await check('UI15 132 新增：横幅在最上面，远程一节在它下面、项目配置之上', `(() => { const kids = [...document.querySelector('.pj-body').children]; const banner = kids.indexOf(document.querySelector('.pj-body > .banner.brand')); const remote = kids.findIndex(x => x.classList.contains('sec-t') && x.textContent.startsWith(${JSON.stringify(pj.remoteSec)})); const config = kids.findIndex(x => x.classList.contains('sec-t') && x.textContent.includes('项目配置')); return banner === 0 && remote > banner && config > remote; })()`);
        await check('UI15 git 版本太旧的横幅只是提示：编辑配置、打开文件夹、更多按钮仍可用', `['[data-pj=edit]', '[data-pj=folder]', '[data-pj=more]', '[data-pj=claude]'].every(s => { const b = document.querySelector(s); return !!b && !b.disabled; })`);
        await shot('projects-oldgit');
    }
    finally { delete process.env.AR_TEST_GIT_VERSION; }
    await reopenProjects();
    await wait(`!document.querySelector('.pj-body > .banner.brand')`, '恢复后横幅消失');
    await check('UI15 git 版本恢复后"版本太旧"横幅消失，配置各行仍在', `!document.querySelector('.pj-body > .banner.brand') && [...document.querySelectorAll('.sec-t')].some(x => x.textContent.includes('项目配置'))`);

    // ---- Stage07b 132：远程状态与推送 / 拉取（真实输入；远程是测试自己建的本机临时裸仓库，绝不连真实远程）----
    const rr = path.join(home, 'shots-projects');
    const bare = path.join(rr, 'origin.git'), cloneDir = path.join(rr, 'origin-clone');
    const configBefore = await readFile(path.join(dir.initialized, '.agent-router', 'project.json'), 'utf8');
    const localMain = () => git(dir.initialized, ['rev-parse', 'refs/heads/main']);
    const bareMain = () => git(bare, ['rev-parse', 'refs/heads/main']);
    const trackingMain = () => git(dir.initialized, ['rev-parse', 'refs/remotes/origin/main']);
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const commitIn = async (cwd: string, file: string, content: string, message: string) => {
        await writeFile(path.join(cwd, file), content);
        git(cwd, ['add', '--', file]);
        commitAs(cwd, message, [file]);
    };
    const remoteLine = `document.querySelector('.rows.remote .r:last-child .v')?.textContent`;
    const remoteButtons = `[...document.querySelectorAll('.rows.remote .r:last-child .btn')].map(b => b.textContent.trim())`;
    // 状态对上，而且刷新 / 推送 / 拉取都结束了（刷新按钮不再禁用）。
    const waitRemote = (state: string, label: string) => wait(`!!document.querySelector('[data-pj-remote=${state}]') && document.querySelector('[data-pj=remote-refresh]')?.disabled === false`, label, 30000);
    const bannerFail = `document.querySelector('.pj-body .banner.fail')`;

    git(rr, ['init', '--bare', '-b', 'main', bare]);
    git(dir.initialized, ['remote', 'add', 'origin', bare]);
    await reopenProjects();
    await waitRemote('noUpstream', '远程一节：origin 上还没有 main');
    await verify('UI15 远程第一行：远程名（等宽）与不含凭据的地址', async () => {
        assert.equal(await evaluate(`document.querySelector('.rows.remote .r .k').textContent`), 'origin');
        assert.equal(await evaluate(`document.querySelector('.rows.remote .r .k').classList.contains('mono')`), true);
        assert.equal(norm(await evaluate(`document.querySelector('.rows.remote .r .v .mono').textContent`)), norm(bare));
    });
    await check('UI15 origin 上还没有 main：第二行是 pj.remoteNoUpstream，右边只有主按钮“推送到 origin”，一节标题右边有“刷新”', `(() => { const rows = document.querySelector('[data-pj-remote=noUpstream]'); const refresh = document.querySelector('.sec-t [data-pj=remote-refresh]'); return ${remoteLine} === ${JSON.stringify(pj.remoteNoUpstream('main', 'origin'))} && ${remoteButtons}.join() === ${JSON.stringify(pj.pushTo('origin'))} && rows.querySelector('.r:last-child .btn').classList.contains('primary') && refresh.textContent.trim() === ${JSON.stringify(pj.remoteRefresh)} && !document.querySelector('[data-pj=remote-pull]'); })()`);
    await shot('projects-remote-noupstream');

    // 推送：新分支推送成功，裸仓库里出现提交，状态变成同步。
    await press('[data-pj=remote-push]');
    await waitRemote('same', '推送后状态变成与 origin 同步');
    await verify('UI15 点“推送到 origin”：裸仓库里的 main 就是本机的 main', () => { assert.equal(bareMain(), localMain()); });
    await check('UI15 推送成功：提示 pj.pushed，状态变成“与 origin 同步 · 最后推送 …”，不再有推送 / 拉取按钮', `(() => { const note = document.querySelector('[data-pj-remote-note]'); const line = ${remoteLine}; return note?.textContent === ${JSON.stringify(pj.pushed('origin', localMain().slice(0, 7)))} && line.startsWith(${JSON.stringify(pj.remoteSame('main', 'origin'))}) && line.includes(${JSON.stringify(pj.remoteLastPush(''))}) && ${remoteButtons}.length === 0 && !document.querySelector('[data-pj=remote-push], [data-pj=remote-pull]'); })()`);

    // 领先 2：本机多两个提交，点“刷新”（联网读取）后显示领先，再推送。
    await commitIn(dir.initialized, 'remote-a1.txt', 'a1\n', '本机新提交一');
    await commitIn(dir.initialized, 'remote-a2.txt', 'a2\n', '本机新提交二');
    await press('[data-pj=remote-refresh]');
    await waitRemote('ahead', '刷新后显示领先 2');
    await check('UI15 领先：“main 领先 origin 2 个提交 · 最后推送 …”，右边主按钮“推送到 origin”', `(() => { const line = ${remoteLine}; return line.startsWith(${JSON.stringify(pj.remoteAhead('main', 'origin', 2))}) && line.includes(${JSON.stringify(pj.remoteLastPush(''))}) && ${remoteButtons}.join() === ${JSON.stringify(pj.pushTo('origin'))} && document.querySelector('.rows.remote .r:last-child .btn').classList.contains('primary'); })()`);
    await shot('projects-remote-ahead');
    const bareBeforePush = bareMain();
    await press('[data-pj=remote-push]');
    await waitRemote('same', '推送领先的提交后同步');
    await verify('UI15 推送 2 个领先的提交：裸仓库里的 main 前进到本机的 main，状态变成同步', () => {
        assert.notEqual(bareMain(), bareBeforePush);
        assert.equal(bareMain(), localMain());
        assert.equal(git(dir.initialized, ['rev-list', '--count', 'refs/remotes/origin/main..refs/heads/main']), '0');
    });
    await check('UI15 推送领先的提交成功：提示 pj.pushed 带“起..止”提交范围', `(() => { const note = document.querySelector('[data-pj-remote-note]')?.textContent ?? ''; return note.startsWith(${JSON.stringify(pj.pushed('origin', ''))}) && note.includes('..') && note.endsWith(${JSON.stringify(localMain().slice(0, 7))}); })()`);

    // 落后：另一个克隆往裸仓库推一个提交，点“刷新”后显示落后和“拉取”，点了以后本机快进。
    git(rr, ['clone', '-q', bare, cloneDir]);
    await commitIn(cloneDir, 'remote-b1.txt', 'b1\n', '另一个克隆的提交');
    git(cloneDir, ['push', '-q', 'origin', 'main']);
    await press('[data-pj=remote-refresh]');
    await waitRemote('behind', '刷新后显示落后 1');
    await check('UI15 落后：“main 落后 origin 1 个提交（只快进，不合并）”，右边次按钮“拉取”（不是主按钮），没有推送按钮', `(() => { const b = document.querySelector('.rows.remote .r:last-child .btn'); return ${remoteLine} === ${JSON.stringify(pj.remoteBehind('main', 'origin', 1))} && ${remoteButtons}.join() === ${JSON.stringify(pj.pull)} && !b.classList.contains('primary') && !document.querySelector('[data-pj=remote-push]'); })()`);
    await shot('projects-remote-behind');
    const localBeforePull = localMain();
    await press('[data-pj=remote-pull]');
    await waitRemote('same', '拉取后同步');
    await verify('UI15 点“拉取”：本机 main 快进到远程的提交，文件出现在工作区，工作区干净', async () => {
        assert.notEqual(localMain(), localBeforePull);
        assert.equal(localMain(), bareMain());
        assert.ok(await exists(path.join(dir.initialized, 'remote-b1.txt')));
        assert.equal(git(dir.initialized, ['status', '--porcelain', '--', 'remote-b1.txt']), '');
        assert.equal(git(dir.initialized, ['rev-list', '--count', `${localBeforePull}..refs/heads/main`]), '1');
    });
    await check('UI15 拉取成功：提示 pj.pulled(1)，状态变成同步', `document.querySelector('[data-pj-remote-note]')?.textContent === ${JSON.stringify(pj.pulled(1))} && !!document.querySelector('[data-pj-remote=same]')`);

    // 分叉：两边各有新提交 → 只有说明，没有按钮；刷新不改动本机和远程。
    await commitIn(dir.initialized, 'remote-d1.txt', 'd1\n', '本机提交（分叉）');
    await commitIn(cloneDir, 'remote-d2.txt', 'd2\n', '另一个克隆的提交（分叉）');
    git(cloneDir, ['push', '-q', 'origin', 'main']);
    const localDiverged = localMain(), bareDiverged = bareMain();
    await press('[data-pj=remote-refresh]');
    await waitRemote('diverged', '刷新后显示分叉');
    await check('UI15 分叉：说明 pj.remoteDiverged(1, 1)，这一行没有任何按钮（既不能推送也不能拉取）', `${remoteLine} === ${JSON.stringify(pj.remoteDiverged(1, 1))} && ${remoteButtons}.length === 0 && !document.querySelector('[data-pj=remote-push], [data-pj=remote-pull]')`);
    await verify('UI15 分叉时刷新只读取：本机 main 与裸仓库 main 都没变', () => { assert.equal(localMain(), localDiverged); assert.equal(bareMain(), bareDiverged); });
    await shot('projects-remote-diverged');
    // 在“终端”里合并后，本机领先远程：回到有推送按钮的状态，给下面的失败场景用。
    git(dir.initialized, ['-c', 'user.name=AgentRouter Shots', '-c', 'user.email=shots@example.invalid', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', 'refs/remotes/origin/main']);
    await press('[data-pj=remote-refresh]');
    await waitRemote('ahead', '合并后本机领先');

    // 推送失败：把远程地址改成不存在的路径 → 失败横幅，本机和远程都不变；按钮变成“重试”。
    git(dir.initialized, ['remote', 'set-url', 'origin', path.join(rr, 'no-such-remote', 'origin.git')]);
    const refsBeforeFail = { local: localMain(), bare: bareMain(), tracking: trackingMain() };
    await press('[data-pj=remote-push]');
    await wait(`!!${bannerFail} && document.querySelector('[data-pj=remote-refresh]')?.disabled === false`, '推送失败的横幅', 60000);
    await check('UI15 推送失败：横幅标题 pj.pushFailedTitle，正文是核心原因 + “什么都没有改动”，推送按钮变成“重试”，没有“复制命令”', `(() => { const b = ${bannerFail}; const text = b.querySelector('.rt span').textContent; return b.querySelector('.rt b').textContent === ${JSON.stringify(pj.pushFailedTitle)} && b.getAttribute('role') === 'alert' && text.includes('取远程状态失败') && text.endsWith(${JSON.stringify('。什么都没有改动。')}) && !document.querySelector('[data-pj=remote-copy]') && ${remoteButtons}.join() === ${JSON.stringify(pj.pushRetry)} && !!document.querySelector('[data-pj-remote=ahead]'); })()`);
    await verify('UI15 推送失败什么都没改：本机 main、裸仓库 main、远程跟踪分支都和失败前一样', () => {
        assert.deepEqual({ local: localMain(), bare: bareMain(), tracking: trackingMain() }, refsBeforeFail);
    });
    await shot('projects-remote-failed');
    // 最小窗口 960×600：远程一节（含失败横幅）不溢出。
    const win = BrowserWindow.getAllWindows()[0];
    const [width0, height0] = win.getContentSize();
    win.setContentSize(960, 600);
    try {
        await pause(500);
        await check('UI15 最小窗口 960×600：远程一节与失败横幅不溢出（没有横向滚动，每一行和横幅的直接子元素右边都在滚动区内（地址一格自己截断，不算））', `(() => { const scroller = document.querySelector('[data-pj-detail] .scroll'); const right = scroller.getBoundingClientRect().right; return innerWidth <= 960 && scroller.scrollWidth <= scroller.clientWidth + 1 && [...document.querySelectorAll('.rows.remote, .rows.remote .r, .rows.remote .r > *, .pj-body .banner, .pj-body .banner > *')].every(e => e.getBoundingClientRect().right <= right + 1); })()`);
        await shot('projects-remote-failed-960x600');
    }
    finally { win.setContentSize(width0, height0); await pause(300); }

    // 没有登录：本机起一个只回 401 的 HTTP 服务（127.0.0.1，随机端口，测完关闭）当“要求登录的远程”；git 不弹窗直接失败 → 登录指引与“复制命令”。
    const server = http.createServer((_request, response) => { response.statusCode = 401; response.setHeader('WWW-Authenticate', 'Basic realm="shots"'); response.end(); });
    const noProxyBefore = process.env.NO_PROXY;
    try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.NO_PROXY = '127.0.0.1,localhost';
        git(dir.initialized, ['remote', 'set-url', 'origin', `http://127.0.0.1:${(server.address() as AddressInfo).port}/shots.git`]);
        await press('[data-pj=remote-push]');
        await wait(`!!document.querySelector('[data-pj=remote-copy]') && document.querySelector('[data-pj=remote-refresh]')?.disabled === false`, '没有登录的横幅', 60000);
        await check('UI15 没有凭据：横幅标题 pj.pushFailedTitle，正文 pj.pushNoCredential，带“复制命令”；什么都没改', `(() => { const b = ${bannerFail}; return b.querySelector('.rt b').textContent === ${JSON.stringify(pj.pushFailedTitle)} && b.querySelector('.rt span').textContent === ${JSON.stringify(pj.pushNoCredential)} && b.querySelector('[data-pj=remote-copy]').textContent.trim() === ${JSON.stringify(pj.pushCopyCommand)} && ${remoteButtons}.join() === ${JSON.stringify(pj.pushRetry)}; })()`);
        await verify('UI15 没有凭据时本机 main、裸仓库 main、远程跟踪分支都没变', () => { assert.deepEqual({ local: localMain(), bare: bareMain(), tracking: trackingMain() }, refsBeforeFail); });
        await shot('projects-remote-nocredential');
        const copies = effects.copyLog.length;
        await press('[data-pj=remote-copy]');
        await h.happened('UI15 复制命令写入剪贴板', () => effects.copyLog.length > copies, 3000);
        await verify('UI15 “复制命令”：剪贴板桩收到 git push origin main', () => { assert.equal(effects.copyLog.at(-1)!.text, 'git push origin main'); });
    }
    finally {
        if (noProxyBefore === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = noProxyBefore;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // 编辑配置的推送三项：填远程名、勾选“批准合并后自动推送”，保存后 project.json 里有 push，且只写改过的键。
    git(dir.initialized, ['remote', 'set-url', 'origin', bare]);
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=\\"push.remote\\"]")', '编辑配置打开');
    await typeIn('[data-pj-f="push.remote"]', 'origin');
    await press('[data-pj-c=afterAccept]');
    await check('UI15 勾选“批准合并后自动推送”：复选框点亮，另一个勾选项不受影响', `document.querySelector('[data-pj-c=afterAccept]').getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-pj-c=afterAccept] .cb.on') && document.querySelector('[data-pj-c=allowLead]').getAttribute('aria-checked') === 'false'`);
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet")', '保存推送设置');
    await verify('UI15 保存推送设置后 project.json 里 push 是 { remote: origin, afterAccept: true }，其余的键原样不动', async () => {
        const saved = await config(dir.initialized);
        assert.deepEqual(saved.push, { remote: 'origin', afterAccept: true });
        const { push: _push, ...rest } = saved;
        assert.deepEqual(rest, JSON.parse(configBefore));
    });
    await press('[data-pj=edit]');
    await wait('!!document.querySelector(".sheet [data-pj-f=\\"push.remote\\"]")', '再次打开编辑配置');
    await check('UI15 再次打开编辑配置：远程名与勾选项都是刚保存的值', `document.querySelector('[data-pj-f="push.remote"]').value === 'origin' && document.querySelector('[data-pj-c=afterAccept]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-pj-c=allowLead]').getAttribute('aria-checked') === 'false'`);
    await key('Escape');
    await wait('!document.querySelector(".sheet")', '关闭编辑配置');
    // 还原：去掉测试用的远程，project.json 回到本段开始前的内容。
    git(dir.initialized, ['remote', 'remove', 'origin']);
    await writeFile(path.join(dir.initialized, '.agent-router', 'project.json'), configBefore);
    await reopenProjects();
    await wait(`!!document.querySelector('[data-pj-remote=none]')`, '还原后远程一节回到“没有远程”');

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
    // 网络代理（099）：不使用时不传 env（终端照旧继承软件的环境）；手动填写时 env 里 HTTPS_PROXY 等于设置的地址，
    // 并补上 NO_PROXY；每次点击都重新算（改了配置不用重开软件）。写 config.json 前记下原内容，结束后原样恢复。
    const proxyConfig = path.join(home, 'config.json');
    const proxyOriginal = await readFile(proxyConfig, 'utf8').catch(() => null);
    const proxyUrl = 'http://127.0.0.1:7890';
    try {
        await verify('UI18 代理不使用（默认）：打开 Claude Code 没有传 env', () => {
            assert.equal(effects.launched.at(-1)!.env, undefined);
        });
        const base = proxyOriginal ? JSON.parse(proxyOriginal) : {};
        await writeFile(proxyConfig, JSON.stringify({ ...base, proxy: { mode: 'manual', url: proxyUrl } }));
        const beforeManual = effects.launched.length;
        await tabTo('[data-pj=claude]'); await key('Enter');
        await until(() => effects.launched.length > beforeManual, '手动代理下打开 Claude Code 的调用');
        await verify('UI18 代理手动填写：打开 Claude Code 传的 env 里 HTTPS_PROXY / HTTP_PROXY 等于设置的地址，NO_PROXY 已补上，参数不变', () => {
            const last = effects.launched.at(-1)!;
            assert.equal(last.env?.HTTPS_PROXY, proxyUrl);
            assert.equal(last.env?.HTTP_PROXY, proxyUrl);
            assert.equal(last.env?.NO_PROXY, 'localhost,127.0.0.1,::1');
            assert.equal(last.cwd, cwd);
            assert.equal(last.args.at(-1), 'claude');
        });
        await writeFile(proxyConfig, JSON.stringify({ ...base, proxy: { mode: 'off', url: proxyUrl } }));
        const beforeOff = effects.launched.length;
        await tabTo('[data-pj=claude]'); await key('Enter');
        await until(() => effects.launched.length > beforeOff, '代理改回不使用后打开 Claude Code 的调用');
        await verify('UI18 代理改回不使用：打开 Claude Code 又没有传 env，代理变量没有被加上', () => {
            assert.equal(effects.launched.at(-1)!.env, undefined);
        });
    }
    finally {
        if (proxyOriginal === null) await rm(proxyConfig, { force: true }); else await writeFile(proxyConfig, proxyOriginal);
    }
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
    // 改写（125）：原断言是默认"只用于这个项目"、底栏写 .git/config；测试环境的全局配置是隔离的、没有身份，新规则默认"本机所有项目（全局）"并在上方加一句 pj.identityGlobalLead。
    await check('UI15 设置身份模态框：本机没有全局身份时默认"本机所有项目（全局）"，上方有说明，底栏写全局 git 配置', `document.querySelector('[data-id-scope=global]')?.classList.contains('on') && document.querySelector('[data-id-scope=global]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-id-scope=repo]')?.getAttribute('aria-pressed') === 'false' && document.querySelector('.sheet [data-id-lead]')?.textContent === ${JSON.stringify(pj.identityGlobalLead)} && document.querySelector('.sheet-f .note')?.textContent.includes('全局 git 配置')`);
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
    // 125：默认是全局，这一段要保存"只用于这个项目"，所以先切过去；底栏说明跟着改成 .git/config。
    await press('[data-id-scope=repo]');
    await check('UI15 切到"只用于这个项目"：按钮点亮，底栏说明改为这个项目的 .git/config', `document.querySelector('[data-id-scope=repo]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-id-scope=global]').getAttribute('aria-pressed') === 'false' && document.querySelector('.sheet-f .note').textContent.includes('这个项目的 .git/config')`);
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
    // 改写（125）：原来是"从默认的只用于这个项目切到本机所有项目"；现在默认就是全局，所以两个方向都点一遍：先切到只用于这个项目，再切回全局。
    await press('[data-id-scope=repo]');
    await check('UI15 切到"只用于这个项目"时底栏说明改为 .git/config', `document.querySelector('[data-id-scope=repo]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet-f .note').textContent.includes('这个项目的 .git/config')`);
    await press('[data-id-scope=global]');
    await check('UI15 切回"本机所有项目"时底栏说明改为全局配置', `document.querySelector('[data-id-scope=global]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet-f .note').textContent.includes('全局 git 配置')`);
    await press('.sheet-btns .btn:last-child');
    await wait('!document.querySelector(".sheet") && !document.querySelector(".banner.brand [data-pj=identity]")', '全局身份保存后横幅消失');
    await verify('UI15 选"本机所有项目"：写进隔离的全局配置，仓库本地配置不写', async () => {
        assert.match(await readFile(globalConfig, 'utf8'), /global@example\.invalid/);
        assert.notEqual(gitStatus(dir.global, ['config', '--local', '--get', 'user.email']).status, 0);
    });
    await check('UI15 全局身份保存后状态行显示"用户名 <邮箱>"', `document.querySelector('.dh-2 .ident')?.textContent.includes('AgentRouter Global <global@example.invalid>')`);
    // 清空隔离的全局配置：后面新建任务页要能稳定复现"没有提交身份"。
    await writeFile(globalConfig, '');

    // ---- 125 不用命令行的提交：项目页"提交…"、缺身份时先补身份再回来、初始化时一起提交已有文件 ----
    // 这一段用自己的临时仓库（测完从登记表移除）；全局 git 配置是隔离的，上面刚清空。
    const commitRoot = path.join(home, 'shots-projects', 'commit');
    const openProject = async (d: string) => {
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task=t1]")', '回到任务页');
        await press('[data-page=projects]');
        await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '重新进入项目页');
        await pick(d);
    };
    const newRepo = async (name: string, { identity = true, commit = true }: { identity?: boolean; commit?: boolean } = {}) => {
        const d = path.join(commitRoot, name);
        await mkdir(d, { recursive: true });
        git(d, ['init', '-b', 'main']);
        if (identity) { git(d, ['config', 'user.name', 'AgentRouter Shots']); git(d, ['config', 'user.email', 'shots@example.invalid']); }
        if (commit) {
            await writeFile(path.join(d, 'README.md'), `# ${name}\n`);
            git(d, ['add', '--', 'README.md']);
            commitAs(d, '初始提交', ['README.md']);
        }
        await core(['projects', 'add', d]);
        return d;
    };
    const countRows = `document.querySelectorAll('.sheet [data-cm-file]').length`;
    const primaryLabel = `document.querySelector('.sheet [data-sheet-btn="1"]').textContent.trim()`;

    // (a) 3 个未提交文件：取消一个、写说明、提交 → 只剩被取消的那个。
    const dirA = await newRepo('commit-pick');
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(dirA, f), `${f}\n`);
    await openProject(dirA);
    await wait(`!!document.querySelector('[data-pj=commit-files]')`, '状态行有"提交…"按钮');
    await check('UI15 状态行"3 个文件未提交"旁有"提交…"按钮', `document.querySelector('.dh-2').textContent.includes(${JSON.stringify(pj.dirty(3))}) && document.querySelector('[data-pj=commit-files]').textContent.trim() === ${JSON.stringify(pj.commitOpen)}`);
    await press('[data-pj=commit-files]');
    await wait(`${countRows} === 3`, '提交弹窗列出 3 个文件');
    await check('UI15 提交弹窗：3 个文件默认全选，表头写"3 / 3 个文件"，按钮写"提交 3 个文件"，底栏写提交身份，焦点在说明', `(() => { const rows = [...document.querySelectorAll('.sheet [data-cm-file]')]; return rows.map(r => r.querySelector('.mono').textContent).join() === 'a.txt,b.txt,c.txt' && rows.every(r => r.getAttribute('aria-checked') === 'true' && r.getAttribute('role') === 'checkbox') && document.querySelector('.sheet [data-cm-all]').getAttribute('aria-checked') === 'true' && document.querySelector('.sheet [data-cm-count]').textContent === ${JSON.stringify(pj.commitPicked(3, 3))} && ${primaryLabel} === ${JSON.stringify(pj.commitDo(3))} && rows.every(r => r.querySelector('.tag').textContent === ${JSON.stringify(pj.commitKinds.add)}) && document.querySelector('.sheet-f .note').textContent === ${JSON.stringify(pj.commitIdentity('AgentRouter Shots', 'shots@example.invalid', false))} && document.activeElement === document.querySelector('[data-cm-message]'); })()`);
    await shot('projects-commit');
    await press('[data-cm-file="1"]');
    await check('UI15 取消勾选 b.txt：表头"2 / 3 个文件"、全选框变半选、按钮"提交 2 个文件"', `document.querySelector('[data-cm-file="1"]').getAttribute('aria-checked') === 'false' && document.querySelector('.sheet [data-cm-all]').getAttribute('aria-checked') === 'mixed' && document.querySelector('.sheet [data-cm-count]').textContent === ${JSON.stringify(pj.commitPicked(2, 3))} && ${primaryLabel} === ${JSON.stringify(pj.commitDo(2))}`);
    const headA = git(dirA, ['rev-parse', 'HEAD']);
    await press('.sheet [data-sheet-btn="1"]');
    await check('UI15 说明为空时点提交：字段下提示"请填写提交说明"，弹窗保持打开', `document.querySelector('[data-cm-error]').textContent === ${JSON.stringify(pj.commitMessageRequired)} && !!document.querySelector('.sheet [data-cm-message]')`);
    await verify('UI15 说明为空时不产生提交', () => { assert.equal(git(dirA, ['rev-parse', 'HEAD']), headA); });
    await type('[data-cm-message]', 'add a and c');
    await check('UI15 开始输入说明后，字段下的提示消失', `document.querySelector('[data-cm-error]').textContent === ''`);
    await press('.sheet [data-sheet-btn="1"]');
    await wait(`!document.querySelector('.sheet') && document.querySelector('.dh-2').textContent.includes(${JSON.stringify(pj.dirty(1))})`, '提交成功：弹窗关闭、状态行只剩 1 个未提交', 30000);
    await verify('UI15 提交 2 个文件：提交只含 a.txt 和 c.txt，说明是输入原文，git status 只剩 b.txt', () => {
        assert.notEqual(git(dirA, ['rev-parse', 'HEAD']), headA);
        assert.deepEqual(git(dirA, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean).sort(), ['a.txt', 'c.txt']);
        assert.equal(git(dirA, ['log', '-1', '--format=%s']), 'add a and c');
        assert.equal(git(dirA, ['status', '--porcelain']), '?? b.txt');
    });
    await check('UI15 提交成功后右下角提示"已提交 <哈希>（2 个文件）"', `document.querySelector('.notice')?.textContent === ${JSON.stringify(pj.commitDone(git(dirA, ['rev-parse', '--short', 'HEAD']), 2))}`);

    // (b) 本机和项目都没有提交身份：提交 → 先弹身份弹窗（默认全局）→ 保存 → 回到提交弹窗，说明与勾选还在 → 提交成功。
    await writeFile(globalConfig, '');
    const dirB = await newRepo('commit-identity', { identity: false });
    for (const f of ['x.txt', 'y.txt']) await writeFile(path.join(dirB, f), `${f}\n`);
    await openProject(dirB);
    await wait(`!!document.querySelector('[data-pj=commit-files]')`, '状态行有"提交…"按钮');
    await press('[data-pj=commit-files]');
    await wait(`${countRows} === 2`, '提交弹窗列出 2 个文件');
    await check('UI15 没有提交身份时提交弹窗底栏没有身份说明', `document.querySelector('.sheet-f .note').textContent === ''`);
    await press('[data-cm-file="1"]');
    await type('[data-cm-message]', 'keep my draft');
    const headB = git(dirB, ['rev-parse', 'HEAD']);
    await press('.sheet [data-sheet-btn="1"]');
    await wait(`!!document.querySelector('.sheet [data-id-f=name]')`, '缺身份：弹出提交身份弹窗', 30000);
    await check('UI15 缺提交身份：提交弹窗关闭，身份弹窗默认"本机所有项目（全局）"并有说明', `!document.querySelector('.sheet [data-cm-message]') && document.querySelectorAll('.sheet').length === 1 && document.querySelector('[data-id-scope=global]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet [data-id-lead]').textContent === ${JSON.stringify(pj.identityGlobalLead)}`);
    await verify('UI15 缺提交身份时不产生提交', () => { assert.equal(git(dirB, ['rev-parse', 'HEAD']), headB); });
    await typeIn('[data-id-f=name]', 'Commit Identity');
    await typeIn('[data-id-f=email]', 'commit-identity@example.invalid');
    await press('.sheet-btns .btn:last-child');
    await wait(`!!document.querySelector('.sheet [data-cm-message]') && !document.querySelector('.sheet [data-id-f=name]')`, '保存身份后回到提交弹窗', 30000);
    await verify('UI15 保存（全局）：隔离的全局配置里有这个身份，仓库本地配置不写', async () => {
        assert.match(await readFile(globalConfig, 'utf8'), /commit-identity@example\.invalid/);
        assert.notEqual(gitStatus(dirB, ['config', '--local', '--get', 'user.email']).status, 0);
    });
    await check('UI15 回到提交弹窗：说明还在，x.txt 勾选、y.txt 没勾，底栏写新身份（全局）', `document.querySelector('[data-cm-message]').value === 'keep my draft' && document.querySelector('[data-cm-file="0"]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-cm-file="1"]').getAttribute('aria-checked') === 'false' && document.querySelector('.sheet [data-cm-count]').textContent === ${JSON.stringify(pj.commitPicked(1, 2))} && document.querySelector('.sheet-f .note').textContent === ${JSON.stringify(pj.commitIdentity('Commit Identity', 'commit-identity@example.invalid', true))}`);
    await press('.sheet [data-sheet-btn="1"]');
    await wait(`!document.querySelector('.sheet')`, '补好身份后提交成功', 30000);
    await verify('UI15 补好身份后提交成功：只含 x.txt，作者是新设的全局身份，y.txt 仍未提交', () => {
        assert.notEqual(git(dirB, ['rev-parse', 'HEAD']), headB);
        assert.deepEqual(git(dirB, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean), ['x.txt']);
        assert.equal(git(dirB, ['log', '-1', '--format=%an <%ae>']), 'Commit Identity <commit-identity@example.invalid>');
        assert.equal(git(dirB, ['status', '--porcelain']), '?? y.txt');
    });
    // 清空隔离的全局配置：后面的页面要能稳定复现"没有提交身份"。
    await writeFile(globalConfig, '');

    // (c) 没有任何提交的文件夹：初始化预览里多一项"一起放进第一个提交"，默认勾上；写入并提交后 git status 干净。
    const dirC = await newRepo('commit-first', { commit: false });
    await mkdir(path.join(dirC, 'src'), { recursive: true });
    await writeFile(path.join(dirC, 'README.md'), '# 第一个提交\n');
    await writeFile(path.join(dirC, 'src', 'app.js'), 'console.log(1);\n');
    await writeFile(path.join(dirC, '.gitignore'), 'dist/\n');
    await mkdir(path.join(dirC, 'dist'), { recursive: true });
    await writeFile(path.join(dirC, 'dist', 'out.js'), 'x\n');
    await openProject(dirC);
    await wait('!!document.querySelector(".banner.brand [data-pj=init]")');
    await press('[data-pj=init]');
    await wait('!!document.querySelector("[data-pj-existing]")', '初始化预览出现"一起放进第一个提交"');
    await check('UI15 没有提交的文件夹：初始化预览多一项"把已有的文件一起放进第一个提交（2 个：…）"，默认勾上，并带说明', `(() => { const b = document.querySelector('[data-pj-existing]'); return b.getAttribute('aria-checked') === 'true' && !!b.querySelector('.cb.on') && b.textContent.includes(${JSON.stringify(pj.initWithExisting(2, 'README.md、src/app.js'))}) && b.textContent.includes(${JSON.stringify(pj.initWithExistingHelp)}); })()`);
    await shot('projects-first-commit');
    await press('[data-pj-existing]');
    await check('UI15 点一下取消勾选，再点一下重新勾上', `document.querySelector('[data-pj-existing]').getAttribute('aria-checked') === 'false' && !document.querySelector('[data-pj-existing] .cb.on')`);
    await press('[data-pj-existing]');
    await check('UI15 重新勾上', `document.querySelector('[data-pj-existing]').getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-pj-existing] .cb.on')`);
    await press('[data-pj=apply]');
    await wait('!!document.querySelector("[data-pj=commit]")', '写入完成', 30000);
    await press('[data-pj=commit]');
    await wait('!!document.querySelector("[data-pj-committed]")', '提交完成', 30000);
    await verify('UI15 勾选"一起放进第一个提交"后：第一个提交含已有文件和约定文件，被忽略的 dist 不在，git status 干净', () => {
        const files = git(dirC, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
        for (const rel of ['README.md', 'src/app.js', '.agent-router/project.json', 'AGENTS.md', '.gitignore']) assert.ok(files.includes(rel), `第一个提交里缺少 ${rel}`);
        assert.ok(!files.includes('dist/out.js'));
        assert.equal(git(dirC, ['rev-list', '--count', 'HEAD']), '1');
        assert.equal(git(dirC, ['status', '--porcelain']), '');
    });
    await wait('!document.querySelector("[data-pj-committed]") && !!document.querySelector("[data-pj=edit]")', '两秒后刷新回配置视图', 6000);
    await check('UI15 提交之后状态行显示"没有未提交的改动"，也没有"提交…"按钮', `document.querySelector('.dh-2').textContent.includes(${JSON.stringify(pj.clean)}) && !document.querySelector('[data-pj=commit-files]')`);
    for (const d of [dirA, dirB, dirC]) await core(['projects', 'remove', d]);

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

    // 133 彻底清理已删除的项目：已登记的项目有两个已结束的任务（带 worktree 目录），用户把文件夹删掉以后，
    // 项目页标出"文件夹已不存在"，确认框三项，确认后项目、任务、worktree 都没了；runs.jsonl 不改（检查结束只去掉本检查自己加的行）。
    {
        const wtRoot = appEnv.AR_WORKTREE_ROOT!;
        assert.ok(wtRoot && path.isAbsolute(wtRoot), '截图验收必须在隔离的 worktree 根目录里运行');
        const goneDir = path.join(home, 'shots-projects', 'gone-project');
        await mkdir(goneDir, { recursive: true });
        await core(['projects', 'add', goneDir, '--allow-non-git']);
        const wtA = path.join(wtRoot, 'e0e0e1-gone-a'), wtB = path.join(wtRoot, 'e0e0e2-gone-b'), wtOther = path.join(wtRoot, 'e0e0e3-other');
        for (const dirName of [wtA, wtB, wtOther]) { await mkdir(dirName, { recursive: true }); await writeFile(path.join(dirName, 'work.txt'), 'x'.repeat(2048)); }
        const runsFile = path.join(home, 'runs.jsonl');
        const started = Date.now() - 120000;
        const goneRows = (id: string, name: string, wt: string, repoPath: string) => [
            { v: 2, event: 'start', id, repo: repoPath, name, dir: path.join(repoPath, '.agent-runs', name), project: path.basename(repoPath), profile: 'fake', adapter: 'fake', label: '假执行者', title: name, spec: null, role: '执行者', pid: 2147483000, started, progress: path.join(repoPath, '.agent-runs', name, 'progress.log'), report: path.join(repoPath, '.agent-runs', name, 'report.md'), model: null, effort: null, tier: null, managed: false, worktree: true, base: 'a'.repeat(40) },
            { v: 1, event: 'worktree', id, dir: wt, branch: `ar/${name}`, base: 'a'.repeat(40), at: started + 1000 },
            { v: 1, event: 'end', id, exit: 0, at: started + 60000, minutes: 1, attempts: 1 },
        ].map(row => JSON.stringify({ at: started, ...row })).join('\n') + '\n';
        // 另一个项目（文件夹还在）的任务和 worktree：不能被动。
        const otherRepo = dir.plain;
        await appendFile(runsFile, goneRows('pg133-a', '001-gone-a', wtA, goneDir) + goneRows('pg133-b', '002-gone-b', wtB, goneDir) + goneRows('pg133-o', '003-other', wtOther, otherRepo));
        await rm(goneDir, { recursive: true, force: true });
        try {
            await press('[data-page=tasks]');
            await wait(`window.dock.snapshot().then(s => ['pg133-a', 'pg133-b'].every(id => s.tasks.some(t => t.id === id)))`, '133 任务进了列表', 20000);
            await press('[data-page=projects]');
            await wait(`[...document.querySelectorAll('[data-pj-row]')].some(b => b.dataset.pjRow === ${JSON.stringify(goneDir)})`, '133 项目页列出已删除文件夹的项目');
            await pick(goneDir);
            await wait('!!document.querySelector("[data-pj=purge]")', '133 详情里有彻底清理按钮', 20000);
            await check('UI15 133 列表行标签是 pj.goneTag', `[...document.querySelectorAll('[data-pj-row]')].find(b => b.dataset.pjRow === ${JSON.stringify(goneDir)}).querySelector('.tag.fail')?.textContent === ${JSON.stringify(pj.goneTag)}`);
            await check('UI15 133 详情：失败横幅 pj.goneTitle / pj.goneHelp(路径, 2)，右边按钮 pj.purgeOpen；没有 git 信息、打开 Claude Code、打开文件夹', `(() => { const b = document.querySelector('.banner.fail'); return b.querySelector('.rt b').textContent === ${JSON.stringify(pj.goneTitle)} && b.querySelector('.rt span').textContent === ${JSON.stringify(pj.goneHelp(goneDir, 2))} && document.querySelector('[data-pj=purge]').textContent.trim() === ${JSON.stringify(pj.purgeOpen)} && b.contains(document.querySelector('[data-pj=purge]')) && !document.querySelector('[data-pj=claude]') && !document.querySelector('[data-pj=folder]') && !document.querySelector('.dh-2 .ident') && document.querySelectorAll('.pj-task').length === 2; })()`);
            await shot('projects-gone');
            await press('[data-pj=purge]');
            await wait('!!document.querySelector(".sheet [data-pj-purge=worktrees]")', '133 彻底清理确认框');
            await check('UI15 133 确认框：标题 pj.purgeTitle、说明 pj.purgeLead、三项默认都勾（任务 2 个、worktree 与名额 2 个）、底栏 pj.purgeNote、确认按钮是危险色', `(() => { const s = document.querySelector('.sheet'); const boxes = [...s.querySelectorAll('[data-pj-purge]')]; const text = key => s.querySelector('[data-pj-purge=' + key + ']').textContent; return s.getAttribute('aria-label') === ${JSON.stringify(pj.purgeTitle('gone-project'))} && s.querySelector('.sheet-lead').textContent === ${JSON.stringify(pj.purgeLead)} && boxes.map(b => b.dataset.pjPurge).join() === 'list,tasks,worktrees' && boxes.every(b => b.getAttribute('aria-checked') === 'true') && text('list').includes(${JSON.stringify(pj.purgeList)}) && text('tasks').includes(${JSON.stringify(pj.purgeTasks(2))}) && text('tasks').includes(${JSON.stringify(pj.purgeTasksHelp)}) && /清理残留的 worktree 与并发名额（2 个，约 4\\.0 KB）/.test(text('worktrees')) && text('worktrees').includes(${JSON.stringify(pj.purgeWorktreesHelp)}) && s.querySelector('.sheet-f .note').textContent === ${JSON.stringify(pj.purgeNote)} && s.querySelector('.sheet-btns .btn:last-child').textContent.trim() === ${JSON.stringify(pj.purgeConfirm)} && s.querySelector('.sheet-btns .btn:last-child').classList.contains('danger'); })()`);
            await shot('projects-purge');
            // "从项目列表移除"必选：点它不会取消勾选。
            await press('[data-pj-purge=list]');
            await check('UI15 133 "从项目列表移除"不可取消：点击后仍是勾选', `document.querySelector('[data-pj-purge=list]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-pj-purge=list] .cb').classList.contains('on')`);
            // 第一次取消：不改任何东西。
            await press('.sheet-btns .btn:first-child');
            await wait('!document.querySelector(".sheet")', '133 取消彻底清理');
            await verify('UI15 133 取消彻底清理：项目还在登记表里，worktree 目录和别的项目的目录都在', async () => {
                assert.ok((await readProjects()).some(p => p.path === goneDir));
                for (const d of [wtA, wtB, wtOther]) assert.ok(await exists(d), `${d} 应还在`);
            });
            const runsBefore = await readFile(runsFile, 'utf8');
            await press('[data-pj=purge]');
            await wait('!!document.querySelector(".sheet [data-pj-purge=worktrees]")', '133 再次打开确认框');
            await press('.sheet-btns .btn:last-child');
            await wait(`!document.querySelector('.sheet') && ![...document.querySelectorAll('[data-pj-row]')].some(b => b.dataset.pjRow === ${JSON.stringify(goneDir)})`, '133 确认后项目从列表消失', 30000);
            await check('UI15 133 成功提示 pj.purged，选中了列表里的下一个项目', `document.querySelector('.notice')?.textContent === ${JSON.stringify(pj.purged('gone-project'))} && !!document.querySelector('[data-pj-row].on') && document.querySelector('[data-pj-row].on').dataset.pjRow !== ${JSON.stringify(goneDir)}`);
            await verify('UI15 133 确认后：登记表里没有它，它的两个 worktree 没了，别的项目的 worktree 还在，runs.jsonl 不改', async () => {
                assert.ok(!(await readProjects()).some(p => p.path === goneDir));
                for (const d of [wtA, wtB]) assert.ok(!(await exists(d)), `${d} 应已删除`);
                assert.ok(await exists(wtOther));
                assert.equal(await readFile(runsFile, 'utf8'), runsBefore);
            });
            await press('[data-page=tasks]');
            await wait(`window.dock.snapshot().then(s => !s.tasks.some(t => t.id === 'pg133-a' || t.id === 'pg133-b') && s.tasks.some(t => t.id === 'pg133-o'))`, '133 它的任务从任务列表消失，别的项目的任务还在', 20000);
            await check('UI15 133 任务列表里没有它的两个任务，别的项目的任务还在', `window.dock.snapshot().then(s => !s.tasks.some(t => t.id === 'pg133-a' || t.id === 'pg133-b') && s.tasks.some(t => t.id === 'pg133-o')) && ![...document.querySelectorAll('[data-task]')].some(x => x.dataset.task === 'pg133-a' || x.dataset.task === 'pg133-b')`);
        }
        finally {
            // 去掉本检查加的行，其余原样；worktree 目录由检查自己清理。
            if (await evaluate('!!document.querySelector(".sheet")')) await key('Escape').catch(() => { });
            const kept = (await readFile(runsFile, 'utf8')).split('\n').filter(line => line && !line.includes('"id":"pg133-'));
            await writeFile(runsFile, kept.length ? kept.join('\n') + '\n' : '');
            for (const d of [wtA, wtB, wtOther]) await rm(d, { recursive: true, force: true });
            await rm(goneDir, { recursive: true, force: true });
            const left = await readProjects();
            if (left.some(p => p.path === goneDir)) await coreRun(['projects', 'remove', goneDir], { timeoutMs: 60000 }).catch(() => { });
            await press('[data-page=projects]');
            await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '133 回到项目页');
        }
    }

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
