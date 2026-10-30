import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { c, gt, rv, wt as w } from '../shared/copy';
import { worktreeState, type WtState } from '../shared/types';
import { pollUntil, type Harness } from './shots-input';
import type { Registry } from './registry';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const jsonStr = JSON.stringify;
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};

// UI30 审查界面（Stage08 158）：验收页与任务详情的"审查"标签、列表徽标、轨道"审查"节点、批准确认提示、需人工处理横幅。
// 用真实核心：测试自己的临时 git 仓库（隔离的公共目录与 AR_WORKTREE_ROOT）、假执行者、经通用适配器接入的假审查者（一个会按次数换结论的小脚本），
// 真实派发、真实审查，成立 / 不成立、再审一次都走 ar review …；全程不碰用户的目录与进程。
export async function captureReview(h: Harness, registry: Registry, out: string, save: (name: string) => Promise<void>, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press, drag, hits, key, type, tabTo, focusRing, pause, audit, wheel } = h;
    // 244：隐藏窗口的原生尺寸先改变，渲染视口要等新帧才同步；只停350ms仍可能读到旧宽布局。
    // 请求一帧并核对原生/渲染尺寸一致，再测布局；保留原等待上限，不通过重试断言求绿。
    const resize = async (width: number, height: number) => {
        win.setContentSize(width, height);
        await win.webContents.capturePage();
        const [actualWidth, actualHeight] = win.getContentSize();
        await wait(`innerWidth === ${actualWidth} && innerHeight === ${actualHeight}`, `UI30 渲染视口同步到原生内容区 ${actualWidth}×${actualHeight}`);
    };
    // 244：窄面板可读性用的匿名长路径与长正文（写进假审查者的结果，不改问题数 / 状态夹具）。
    const longFile = 'src/' + 'very-long-anonymous-directory-name/'.repeat(5) + 'notes.txt';
    const longDetail = '这是一段很长的匿名说明，用来确认窄面板里问题正文可以完整换行阅读，不会截断或横向撑出面板。'.repeat(3);
    const home = appEnv.AGENT_ROUTER_HOME!, worktreeRoot = appEnv.AR_WORKTREE_ROOT!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    assert.ok(worktreeRoot && path.resolve(worktreeRoot).toLowerCase().startsWith(path.resolve(home).toLowerCase()), 'worktree 根目录必须在隔离公共目录里');
    const tasksFile = path.join(registry.data, 'tasks.json'), configFile = path.join(home, 'config.json');
    const root = path.join(home, 'shots-review'), repo = path.join(root, 'sample');
    const reviewerFile = path.join(root, 'reviewer.mjs');
    const jsonOf = async <T,>(file: string, fallback: T): Promise<T> => JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
    const hiddenOf = async () => { const saved = await jsonOf<{ hidden?: string[] }>(tasksFile, {}); return Array.isArray(saved.hidden) ? saved.hidden : []; };
    const writeHidden = async (hidden: string[]) => { const saved = await jsonOf<Record<string, unknown>>(tasksFile, { imports: [] }); await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set(hidden)] }) + '\n'); await registry.reloadHidden(); };
    const rows = async () => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as any[];
    const eventsOf = async (id: string) => (await rows()).filter(r => r.id === id);
    const untilRow = async <T,>(fn: () => Promise<T | undefined | null>, label: string, timeoutMs = 90000): Promise<T> => {
        let value: T | undefined | null;
        if ((await pollUntil(async () => (value = await fn()), timeoutMs, 200)).ok) return value as T;
        throw Error(`等待超时：${label}（${timeoutMs} ms）`);
    };
    const taskOf = (id: string) => registry.tasks.find(t => t.id === id);
    const untilState = async (id: string, state: WtState, timeoutMs = 90000) => untilRow(async () => { await registry.refresh(); const t = taskOf(id); return t && worktreeState(t) === state ? t : null; }, `任务 ${id} 进入 ${state}`, timeoutMs);
    const core = async (args: string[], cwd?: string) => {
        const r = await coreRun(args, { timeoutMs: 120000, cwd });
        assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
        assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
        return r.json;
    };
    // 深浅色 × 默认 / 最小窗口各一张截图（深浅色 × 默认 / 最小窗口四张）。
    const shots = async (name: string) => {
        for (const [width, height, suffix] of [[1160, 720, ''], [960, 600, '-960x600']] as const) {
            await resize(width, height);
            for (const theme of ['dark', 'light'] as const) {
                nativeTheme.themeSource = theme;
                await pause(350);
                await save(`${name}-${theme}${suffix}`);
            }
        }
        await resize(1160, 720);
        nativeTheme.themeSource = 'dark';
        await pause(350);
    };
    const goTasks = async () => { await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task]")'); await press('[data-filter=all]'); };
    const goAccept = async () => { await press('[data-page=accept]'); await wait('!!document.querySelector("[data-acc]") || !!document.querySelector(".acc-main .empty")', 'UI30 验收页出现'); };
    const selectTask = async (id: string) => {
        await goTasks();
        const row = `!!document.querySelector('[data-task="${id}"]')`;
        if (!(await pollUntil(() => evaluate(row), 8000, 200)).ok) { await press('[data-project]'); await press('.ctx button'); await wait(row, `UI30 任务页出现任务 ${id}`, 20000); }
        await press(`[data-task="${id}"]`);
        await wait(`document.querySelector('[data-task="${id}"]')?.classList.contains('on') === true`, `UI30 选中任务 ${id}`);
    };
    const selectAccept = async (id: string) => {
        await goAccept();
        await wait(`!!document.querySelector('[data-acc="${id}"]')`, `UI30 验收页出现任务 ${id}`, 20000);
        await press(`[data-acc="${id}"]`);
        await wait(`document.querySelector('.trow.on')?.dataset.acc === ${jsonStr(id)}`, `UI30 验收页选中 ${id}`);
    };
    const openReviewTab = async (id: string) => {
        await selectAccept(id);
        await press('[data-atab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && !!document.querySelector('[data-rv-card]')`, 'UI30 审查标签出现问题卡片', 20000);
    };
    const reviewFile = (name: string) => path.join(repo, '.agent-runs', name, 'review.json');
    const reviewOf = async (name: string) => JSON.parse(await readFile(reviewFile(name), 'utf8'));

    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const originalHidden = await hiddenOf();
    const touched: { id: string; started: number }[] = [];
    let registered = false;
    try {
        // ================= 准备：临时仓库、假执行者、假审查者、任务说明 =================
        await mkdir(path.join(repo, 'src'), { recursive: true });
        await mkdir(path.join(repo, 'docs', 'specs'), { recursive: true });
        await mkdir(path.join(repo, '.agent-router'), { recursive: true });
        git(repo, ['init', '-b', 'main']);
        git(repo, ['config', 'user.name', 'AgentRouter Shots']);
        git(repo, ['config', 'user.email', 'shots@example.invalid']);
        git(repo, ['config', 'commit.gpgsign', 'false']);
        git(repo, ['config', 'core.autocrlf', 'false']);
        const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';
        await writeFile(path.join(repo, '.gitignore'), '.agent-runs/\n');
        // a.txt、b.txt 各 60 行，执行者整个重写（改动里各有 60 个删除行和 60 个新增行，前两个文件默认展开，把 z.txt 顶到视口下面）。
        await writeFile(path.join(repo, 'src', 'a.txt'), lines('a', 60));
        await writeFile(path.join(repo, 'src', 'b.txt'), lines('b', 60));
        await writeFile(path.join(repo, 'src', 'z.txt'), 'z1\nz2\nz3\n');
        await writeFile(path.join(repo, '.agent-router', 'project.json'), JSON.stringify({ v: 1, name: 'review-sample', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2) + '\n');
        const spec = (id: number, title: string, allowed: string, extra: string[]) => ['---', `id: ${id}`, `title: ${title}`, 'type: code', 'allowed_paths:', `  - ${allowed}`, 'verify:', '  - git cat-file -e HEAD:src/z.txt', 'max_retries: 0', 'review: true', ...extra, '---', '', '## 目标', '', `${title}：审查界面检查用的任务。`, '', '## 范围 / 不做什么', '', '只改允许的文件。', ''].join('\n');
        await writeFile(path.join(repo, 'docs', 'specs', '951-审查界面.md'), spec(951, '审查界面任务', 'src/**', []));
        await writeFile(path.join(repo, 'docs', 'specs', '953-审查进行中.md'), spec(953, '审查进行中任务', 'docs/slow/**', []));
        await writeFile(path.join(repo, 'docs', 'specs', '952-审查拦截.md'), spec(952, '审查拦截任务', 'docs/block/**', ['review_block: high']));
        git(repo, ['add', '--', '.gitignore', 'src', '.agent-router/project.json', 'docs/specs']);
        git(repo, ['commit', '-m', '初始提交', '--', '.gitignore', 'src', '.agent-router/project.json', 'docs/specs']);
        await core(['projects', 'add', repo]);
        registered = true;
        // 假审查者（通用适配器的文本型命令行）：按计数文件换结论，只读，不改任何文件。
        await writeFile(reviewerFile, [
            "import { readFileSync, writeFileSync } from 'node:fs';",
            "const args = process.argv.slice(2);",
            "if (args.includes('--version')) { console.log('shots-reviewer 1.0'); process.exit(0); }",
            "const [stateFile, list] = args;",
            "let count = 0;",
            "try { count = Number(readFileSync(stateFile, 'utf8')) || 0; } catch { }",
            "writeFileSync(stateFile, String(count + 1));",
            `const longFile = ${JSON.stringify(longFile)};`,
            `const longDetail = ${JSON.stringify(longDetail)};`,
            "const modes = list.split(',');",
            "const mode = modes[Math.min(count, modes.length - 1)];",
            "console.log('读写模式：' + (args.includes('--read-only') ? 'readonly' : 'readwrite'));",
            "const json = value => console.log('```json\\n' + JSON.stringify(value) + '\\n```');",
            "const issue = (severity, file, line, title, detail) => ({ severity, file, line, title, detail });",
            "if (mode === 'main') json({ verdict: 'concerns', summary: '功能完成，但有几处要看', reviewed: ['src/a.txt', 'src/z.txt', longFile], issues: [",
            "  issue('low', 'src/a.txt', 500, '低：这一行不在改动里', '审查者指的行超出了文件，改动里找不到。'),",
            "  issue('medium', 'src/a.txt', 5, '中：第 5 行的写法', '这一行在默认展开的第一个文件里。'),",
            "  issue('high', 'src/z.txt', 2, '高：z.txt 第 2 行', '这个文件在改动列表的最后，默认是收起的。'),",
            "  issue('medium', 'docs/none.md', 3, '中：文件不在改动里', longDetail),",
            "] });",
            "else if (mode === 'again') json({ verdict: 'concerns', summary: '再审：只剩两条', reviewed: ['src/b.txt'], issues: [",
            "  issue('medium', 'src/b.txt', 3, '再审的中问题', '第二次审查给出的意见。'),",
            "  issue('low', 'src/a.txt', 2, '再审的低问题', '第二次审查给出的小意见。'),",
            "] });",
            "else if (mode === 'slow') { await new Promise(resolve => setTimeout(resolve, 12000)); json({ verdict: 'pass', summary: '没有发现问题', reviewed: ['docs/slow/n.txt'], issues: [] }); }",
            "else json({ verdict: 'concerns', summary: '有一个必须处理的问题', reviewed: ['docs/block/n.txt'], issues: [issue('high', 'docs/block/n.txt', 1, '高：拦截任务的问题', '拦截模式下返工次数用完后交给人。')] });",
            '',
        ].join('\n'));
        const generic = (label: string, modes: string) => {
            const state = path.join(root, `count-${label}.txt`);
            return { label, executable: process.execPath, detect: [reviewerFile, '--version'], args: [reviewerFile, state, modes, '{promptFile}'], readOnlyArgs: [reviewerFile, state, modes, '--read-only', '{promptFile}'], output: { format: 'text' } };
        };
        const fake = (label: string, extra: Record<string, unknown>) => ({ adapter: 'fake', label, model: 'deepseek-v4-flash', enabled: true, events: [{ kind: 'say', text: `${label}：假执行者已完成。` }], report: '# 完成了什么\n\n假汇报。\n', exit: 0, version: 'fake-agent 1.0', ...extra });
        await writeFile(configFile, JSON.stringify({
            v: 2, defaultProfile: 'a', managed: false, watchWindow: 'never', concurrency: 2,
            profiles: {
                a: fake('甲执行者', { writes: [{ path: 'src/a.txt', content: lines('A', 60) }, { path: 'src/b.txt', content: lines('B', 60) }, { path: 'src/z.txt', content: 'z1\nZ2 changed\nz3\n' }], commit: '甲：重写 a、b，改 z' }),
                slower: fake('慢审查执行者', { writes: [{ path: 'docs/slow/n.txt', content: 'slow\n' }], commit: '慢：新增 docs/slow/n.txt' }),
                blocker: fake('阻断执行者', { writes: [{ path: 'docs/block/n.txt', content: 'block\n' }], commit: '阻断：新增 docs/block/n.txt' }),
                rev1: { adapter: 'generic', generic: 'rev1', label: '审查甲', model: 'kimi-k3', enabled: true },
                rev2: { adapter: 'generic', generic: 'rev2', label: '审查乙', model: 'kimi-k3', enabled: true },
            },
            generics: { rev1: generic('审查甲', 'main,high,slow'), rev2: generic('审查乙', 'again') },
            routing: { rules: [], fallback: null, reviewer: { profiles: ['rev1', 'rev2'], mustDiffer: true, differFromLead: true } },
            review: { default: false, block: 'none', maxReworks: 0 },
        }, null, 2) + '\n');
        const dispatchTask = async (rel: string, name: string, profile: string) => {
            const r = await core(['dispatch', `docs/specs/${rel}.md`, '--name', name, '--profile', profile, '--host', 'agentrouter', '--detach'], repo);
            const id = String(r.id);
            assert.ok(id, '派发没有返回 id');
            await untilRow(async () => (await rows()).find(x => x.id === id && x.event === 'start'), `任务 ${name} 的 start`, 30000);
            const start = (await rows()).find(x => x.id === id && x.event === 'start');
            touched.push({ id, started: start.started });
            return { id, name };
        };
        const M = await dispatchTask('951-审查界面', 'rv-main', 'a');
        await untilState(M.id, 'awaiting', 150000);
        console.log('验收检查进度：审查界面的真实任务进入待验收');

        // ================= 数据：清单事件与注册表摘要 =================
        const mainRows = await eventsOf(M.id);
        const names = mainRows.map(r => r.event);
        await verify('UI30 清单里按 gate → attempt-end → reviewing → review → end 的顺序写了审查事件；review 事件带审查者 rev1、交叉、结论 concerns、4 个问题、其中高 1 个', () => {
            const at = (event: string) => names.indexOf(event);
            assert.ok(at('gate') < at('reviewing') && at('reviewing') < at('review') && at('review') < at('end'), names.join());
            const review = mainRows.find(r => r.event === 'review');
            assert.deepEqual([review.reviewer, review.crossed, review.verdict, review.issues, review.high], ['rev1', true, 'concerns', 4, 1]);
        });
        const tM = taskOf(M.id)!;
        await verify('UI30 注册表解析出 Task.review 摘要（审查者、结论、问题数、高严重度数），审查结束后 reviewing 已清掉', () => {
            assert.deepEqual([tM.review?.reviewer, tM.review?.crossed, tM.review?.verdict, tM.review?.issues, tM.review?.high, tM.reviewing], ['rev1', true, 'concerns', 4, 1, undefined]);
        });
        await verify('UI30 review.json 的问题编号是 R1-1～R1-4，按审查者给的顺序：低、中、高、中', async () => {
            const review = await reviewOf('rv-main');
            assert.deepEqual(review.issues.map((i: any) => [i.id, i.severity]), [['R1-1', 'low'], ['R1-2', 'medium'], ['R1-3', 'high'], ['R1-4', 'medium']]);
        });

        // ================= 任务页：列表徽标、轨道"审查"节点、详情的"审查"标签 =================
        await selectTask(M.id);
        await check('UI30 列表第二行：门禁徽标后面是审查徽标"审查 4 个问题"（rv.badgeIssues(4)），没有审查的任务没有这个徽标', `(() => { const row = document.querySelector('[data-task="${M.id}"]'); const badges = [...row.querySelectorAll('.gbadge')]; return badges.length === 2 && badges[0].textContent.trim() === ${jsonStr(gt.badge.ok)} && badges[1].dataset.reviewBadge !== undefined && badges[1].textContent.trim() === ${jsonStr(rv.badgeIssues(4))} && [...document.querySelectorAll('[data-task]')].filter(r => r.dataset.task !== ${jsonStr(M.id)}).every(r => !r.querySelector('[data-review-badge]')); })()`);
        await wait('document.querySelectorAll(".track .node").length === 6', 'UI30 详情轨道有六个节点');
        await check('UI30 轨道：派发 · 执行 · 门禁 · 审查 · 待验收 · 合并，审查节点在门禁与待验收之间，小字是 rv.nodeIssues(4)，aria-label 带审查者，样式是"需要你"（attn）', `(() => { const n = [...document.querySelectorAll('.track .node')]; return n.map(x => x.children[1].textContent).join('/') === ${jsonStr([gt.track.dispatch, gt.track.run, gt.track.gate, rv.node, w.track.awaiting, w.track.merge].join('/'))} && n[3].querySelector('.sub').textContent === ${jsonStr(rv.nodeIssues(4))} && n[3].classList.contains('attn') && n[3].dataset.tab === 'review' && n[3].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(rv.node, `${rv.badgeIssues(4)}（rev1）`))} && !n[3].disabled; })()`);
        await check('UI30 详情标签栏：有审查的任务多一个"审查"，紧跟在"门禁"后面、"改动"前面', `(() => { const keys = [...document.querySelectorAll('.dtabs [data-tab]')].map(b => b.dataset.tab); const i = keys.indexOf('review'); return i > 0 && keys[i - 1] === 'gate' && keys[i + 1] === 'files' && document.querySelector('.dtabs [data-tab=review]').textContent.trim() === ${jsonStr(rv.tab)}; })()`);
        await press('.track .node[data-tab=review]');
        await wait(`document.querySelector('.dtabs [data-tab=review]').classList.contains('on') && document.querySelectorAll('[data-rv-card]').length === 4`, 'UI30 点轨道审查节点：到审查标签并读到 4 张卡片', 20000);
        await check('UI30 详情的审查标签：卡片按严重度排序（高、中、中、低），编号 R1-3、R1-2、R1-4、R1-1，与 review.json 一致', `JSON.stringify([...document.querySelectorAll('[data-rv-card]')].map(c => [c.dataset.rvCard, c.dataset.severity])) === ${jsonStr(jsonStr([['R1-3', 'high'], ['R1-2', 'medium'], ['R1-4', 'medium'], ['R1-1', 'low']]))}`);
        // 说明框的焦点保护（任务详情）：在说明框里输入几个字，让核心写一次确认（别处——例如主导——写了确认，清单变了、审查标签刷新），焦点和文字都还在。
        await type('[data-rv-note="R1-1"]', '详情页里的说明');
        await core(['review', 'confirm', 'rv-main', 'R1-2', 'valid', '--by', 'lead'], repo);
        await wait(`!!document.querySelector('[data-rv-card="R1-2"] [data-rv-conf="valid"]')`, 'UI30 详情的审查标签刷新出 R1-2 已确认成立（lead 写的）', 20000);
        await check('UI30 详情里说明框保住焦点与文字：刷新后焦点仍在 R1-1 的说明框，文字、光标位置都没变', `(() => { const a = document.activeElement; return a?.dataset.rvNote === 'R1-1' && a.value === '详情页里的说明' && a.selectionStart === a.value.length; })()`);
        await verify('UI30 lead 写的确认：review.json 里 R1-2 是 valid、by 为 lead，清单里有 review-confirm 事件', async () => {
            const issue = (await reviewOf('rv-main')).issues.find((i: any) => i.id === 'R1-2');
            assert.deepEqual([issue.confirmation.result, issue.confirmation.by], ['valid', 'lead']);
            assert.ok((await eventsOf(M.id)).some(r => r.event === 'review-confirm' && r.issue === 'R1-2' && r.by === 'lead'));
        });
        // 没写完的说明不算数：清掉，下面从头测。
        await core(['review', 'confirm', 'rv-main', 'R1-2', 'invalid', '--by', 'lead'], repo);
        await wait(`!!document.querySelector('[data-rv-card="R1-2"] [data-rv-conf="invalid"]')`, 'UI30 详情的审查标签刷新出 R1-2 已确认不成立', 20000);
        // 任务详情里点文件:行：待验收的任务去验收页的"改动"标签并定位（详情页自己没有可看的 diff）。
        await press('button[data-rv-jump][data-rv-file="src/z.txt"]');
        await wait(`document.querySelector('[data-page=accept]').getAttribute('aria-current') === 'page' && document.querySelector('[data-atab=diff]')?.classList.contains('on') && !!document.querySelector('.dl.rv-hit')`, 'UI30 详情页点 src/z.txt:2：到验收页的改动标签并标出这一行', 30000);
        await check('UI30 详情页点文件:行：选中的是这个任务，z.txt 展开，标出的行是第 2 行', `document.querySelector('.trow.on')?.dataset.acc === ${jsonStr(M.id)} && document.querySelector('.dl.rv-hit .no').textContent === '2' && document.querySelector('.dl.rv-hit').closest('[data-df-box]').querySelector('.df-h .p').textContent === 'src/z.txt'`);

        // ================= 验收页：标签、横幅、摘要、徽标 =================
        await selectAccept(M.id);
        await check('UI30 验收页：列表行有审查徽标；标签栏四个标签，"审查"可点（不再是灰的），文字 rv.tab；概览摘要多"审查"一项（通过 / 问题数 · 审查者）', `(() => { const tabs = [...document.querySelectorAll('.detail.acc .dtabs button')]; const sum = document.querySelector('.detail.acc [data-rv-sum]'); return tabs.map(b => b.dataset.atab).join() === 'overview,diff,gate,review' && tabs[3].disabled === false && tabs[3].textContent.trim() === ${jsonStr(rv.tab)} && !!document.querySelector('[data-acc="${M.id}"] [data-review-badge]') && sum?.textContent === ${jsonStr(`${rv.overviewRow}${rv.nodeIssues(4)} · 审查甲`)}; })()`);
        await check('UI30 验收页轨道也有审查节点（六个节点），点它切到审查标签', `document.querySelectorAll('.detail.acc .track .node').length === 6`);
        await press('.detail.acc .track .node[data-tab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && document.querySelectorAll('[data-rv-card]').length === 4`, 'UI30 验收页点审查节点：到审查标签', 20000);
        await check('UI30 审查标签：结论横幅（标题 rv.verdict.concerns；审查者、交叉、用时 + 摘要）、问题卡片按严重度排序、编号与 review.json 一致、每张卡片有严重度标签、标题、说明、文件:行按钮', `(() => { const head = document.querySelector('[data-rv-head]'); const cards = [...document.querySelectorAll('[data-rv-card]')]; return head.classList.contains('info') && head.querySelector('.rt b').textContent === ${jsonStr(rv.verdict.concerns)} && head.querySelector('.rt span').textContent.startsWith(${jsonStr(rv.by('审查甲', true, '\u0000').split('\u0000')[0])}) && head.querySelector('.rt span').textContent.includes('功能完成，但有几处要看') && cards.map(c => c.dataset.rvCard).join() === 'R1-3,R1-2,R1-4,R1-1' && cards.map(c => c.querySelector('.tag').textContent).join() === ${jsonStr(['高', '中', '中', '低'].join())} && cards.map(c => c.querySelector('[data-rv-jump]').textContent).join() === ${jsonStr(['src/z.txt:2', 'src/a.txt:5', 'docs/none.md:3', 'src/a.txt:500'].join())} && cards.every(c => c.querySelector('b').textContent.length > 0 && c.querySelector('.rv-b p').textContent.length > 0 && c.querySelectorAll('.segm button').length === 2); })()`);
        await check('UI30 审查标签：看过的文件独立一区（rv.reviewed 标题、完整路径列表）和"再审一次…"按钮在底部一区，长路径完整保留', `(() => { const f = document.querySelector('[data-rv-reviewed]'); const files = [...document.querySelectorAll('[data-rv-reviewed-file]')].map(el => el.textContent); const head = f?.querySelector('.rv-reviewed-head > span'); const again = f?.querySelector('[data-rv-again]'); return !!f && document.querySelector('.tab-body').lastElementChild === f && head?.textContent === ${jsonStr(rv.reviewed)} && files.length === 3 && files.includes('src/a.txt') && files.includes(${jsonStr(longFile)}) && again?.textContent.trim() === ${jsonStr(rv.again)}; })()`);
        await shots('review-tab');
        // 244：深浅 × 两种窗口尺寸都用真实布局读回可读性（不只是截图）。
        for (const [width, height] of [[1160, 720], [960, 600]] as const) for (const theme of ['dark', 'light'] as const) {
            await resize(width, height);
            nativeTheme.themeSource = theme;
            await pause(350);
            const where = `${theme}，${width}×${height}`;
            await check(`UI30 244 审查标签（${where}）：看过的文件独立成区，标题一行，完整路径换行可读，再审按钮在标题行里可操作`, `(() => {
                const box = document.querySelector('[data-rv-reviewed]');
                const head = box?.querySelector('.rv-reviewed-head');
                const title = head?.querySelector('span');
                const files = [...document.querySelectorAll('[data-rv-reviewed-file]')];
                const long = files.find(el => el.textContent === ${jsonStr(longFile)});
                const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
                const fits = el => el.scrollWidth <= el.clientWidth + 1;
                const again = box?.querySelector('[data-rv-again]');
                return !!box && document.querySelector('.tab-body')?.lastElementChild === box && !!title && title.textContent === ${jsonStr(rv.reviewed)} && lines(title) === 1 && fits(head) && files.length === 3 && !!long && lines(long) > 1 && fits(long) && fits(again) && again.getBoundingClientRect().width > 0 && again.getBoundingClientRect().height > 0;
            })()`);
            await check(`UI30 244 审查标签（${where}）：问题长正文换行读完，标题、文件行、成立/不成立按钮不被压成竖排、不撑出面板`, `(() => {
                const card = document.querySelector('[data-rv-card="R1-4"]');
                const body = card?.querySelector('.rv-b p'), title = card?.querySelector('.rv-h b'), jump = card?.querySelector('[data-rv-jump]');
                const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
                const fits = el => el.scrollWidth <= el.clientWidth + 1;
                const buttons = [...(card?.querySelectorAll('.segm button') ?? [])];
                return !!card && body.textContent === ${jsonStr(longDetail)} && lines(body) > 1 && fits(body) && fits(title) && fits(jump) && buttons.length === 2 && buttons.every(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0);
            })()`);
            await check(`UI30 244 审查标签（${where}）：面板与整页都没有水平越界`, `(() => { const sc = document.querySelector('.detail.acc .dbody .scroll'); return document.scrollingElement.scrollWidth <= innerWidth && (!sc || sc.scrollWidth <= sc.clientWidth + 1); })()`);
            const box = await hits('[data-rv-again]');
            await verify(`UI30 244 审查标签（${where}）：再审按钮命中可点`, () => assert.ok(!('error' in box), 'error' in box ? box.error : ''));
            const sc = '.detail.acc .dbody .scroll';
            await wheel(sc, -3000);
            const beforeScroll = await evaluate(`document.querySelector(${jsonStr(sc)})?.scrollTop`);
            await wheel(sc, 3000);
            await check(`UI30 244 审查标签（${where}）：真实滚轮滚到父容器纵向底部后，最后一个看过的文件完整可见`, `(() => { const sc = document.querySelector(${jsonStr(sc)}); const last = [...document.querySelectorAll('[data-rv-reviewed-file]')].at(-1); if (!sc || !last) return false; const r = last.getBoundingClientRect(), v = sc.getBoundingClientRect(); return sc.scrollTop > ${beforeScroll} && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5 && r.height > 0; })()`);
        }
        await resize(1160, 720);
        nativeTheme.themeSource = 'dark';
        await pause(350);
        // 244：两个宿主的流水线在最小窗口用真实鼠标拖动；Tab 到末节点、刷新后焦点与浏览位置都保留，键盘仍能激活。
        const trackHost = async (kind: 'tasks' | 'accept') => {
            const scope = kind === 'accept' ? '.detail.acc' : '.detail:not(.acc)';
            const track = `${scope} .track`, last = `${track} .node:last-of-type`;
            const where = kind === 'accept' ? '验收页' : '任务详情';
            const activeTab = kind === 'accept' ? '[data-atab=review]' : '.dtabs [data-tab=review]';
            await resize(960, 600);
            nativeTheme.themeSource = 'dark';
            await pause(350);
            if (kind === 'tasks') {
                await press('.dtabs [data-tab=review]');
                await wait(`document.querySelector('.dtabs [data-tab=review]').classList.contains('on') && document.querySelectorAll('[data-rv-card]').length === 4`, 'UI30 244 任务详情审查标签', 20000);
            }
            // 单次原子读取故障瞬间的几何与页面状态；失败图在 finally 清理前保存。
            const geometry = await evaluate(`(() => {
                const tracks = [...document.querySelectorAll(${jsonStr(track)})], tr = tracks[0];
                const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, left:r.left, right:r.right }; };
                const css = el => el ? { display:getComputedStyle(el).display, overflowX:getComputedStyle(el).overflowX } : null;
                return { innerWidth, innerHeight, page:document.querySelector('[data-page][aria-current="page"]')?.dataset.page ?? null,
                    taskSelected:!!document.querySelector('.trow.on'), tab:document.querySelector(${jsonStr(activeTab)})?.className ?? null,
                    trackCount:tracks.length, nodeCount:tr?.querySelectorAll('.node').length ?? 0,
                    clientWidth:tr?.clientWidth ?? null, scrollWidth:tr?.scrollWidth ?? null, scrollLeft:tr?.scrollLeft ?? null,
                    track:rect(tr), holder:rect(tr?.parentElement), detail:rect(tr?.closest('.detail')),
                    children:tr ? [...tr.children].map(el => ({ className:el.className, bounds:rect(el) })) : [],
                    trackCss:css(tr), holderCss:css(tr?.parentElement) };
            })()`);
            const nativeSize = win.getContentSize(), minimumSize = win.getMinimumSize();
            await writeFile(path.join(out, `review-track-${kind}-geometry.json`), JSON.stringify({ ...geometry, requestedSize: [960, 600], nativeSize, minimumSize }, null, 2));
            // 用户批准：实际最小内容高度可能含原生边框取整差异；严格核对960宽、产品最小尺寸及渲染/原生一致。
            const geometryOk = minimumSize[0] === 960 && minimumSize[1] === 600 && nativeSize[0] === 960 && geometry.innerWidth === 960 && geometry.innerHeight === nativeSize[1] && geometry.trackCount === 1 && geometry.nodeCount === 6 && geometry.scrollWidth > geometry.clientWidth;
            if (!geometryOk) await save(`review-track-${kind}-geometry-failure`);
            await verify(`UI30 244 ${where}流水线（960×600）：6 个节点超出窄面板，可在自身区域横向滚动`, () => assert.equal(geometryOk, true, `即时几何：${JSON.stringify(geometry)}`));
            await drag(track, -100);
            const dragged = await evaluate(`document.querySelector(${jsonStr(track)}).scrollLeft`);
            await check(`UI30 244 ${where}流水线：真实鼠标按住拖动改变横向位置，拖动不切换标签`, `(() => { const tr = document.querySelector(${jsonStr(track)}); return tr.scrollLeft >= 40 && document.querySelector(${jsonStr(activeTab)}).classList.contains('on'); })()`);
            await drag(track, 100);
            const draggedBack = await evaluate(`document.querySelector(${jsonStr(track)}).scrollLeft`);
            await check(`UI30 244 ${where}流水线：反方向拖动回到接近起点（${dragged} → ${draggedBack}）`, `${draggedBack} < 40`);
            // 轻点仍是原点击：门禁节点切到门禁标签，审查节点切回审查标签；拖动之后的这次点击已经过去（只吞拖动那一次）。
            const gateTab = kind === 'accept' ? '[data-atab=gate]' : '.dtabs [data-tab=gate]';
            await press(`${track} .node[data-tab=gate]`);
            await wait(`document.querySelector(${jsonStr(gateTab)}).classList.contains('on')`, `UI30 244 ${where}流水线轻点切到门禁标签`, 15000);
            await press(`${track} .node[data-tab=review]`);
            await wait(`document.querySelector(${jsonStr(activeTab)}).classList.contains('on') && !!document.querySelector('[data-rv-card]')`, `UI30 244 ${where}流水线轻点审查节点切回`, 20000);
            await check(`UI30 244 ${where}流水线：轻点节点仍按原行为切标签（门禁 → 审查）`, `document.querySelector(${jsonStr(activeTab)}).classList.contains('on') && !!document.querySelector(${jsonStr(gateTab)})`);
            await tabTo(last, 160);
            await focusRing(`UI30 244 ${where}流水线末节点（Tab 后焦点环）`);
            await check(`UI30 244 ${where}流水线：Tab 到末节点后它完整落在轨道可视范围内，可用键盘继续操作`, `(() => { const tr = document.querySelector(${jsonStr(track)}), a = document.activeElement, node = tr.querySelector('.node:last-of-type'); const r = node.getBoundingClientRect(), t = tr.getBoundingClientRect(); return a === node && tr.scrollLeft > 0 && r.left >= t.left - 0.5 && r.right <= t.right + 0.5; })()`);
            const before = await evaluate(`document.querySelector(${jsonStr(track)}).scrollLeft`);
            await evaluate(`window.__ar244Node = document.querySelector(${jsonStr(last)}); true`);
            // 真实的核心写入让清单里的 review 事件变化，宿主刷新 / 完整重画（不是测试里手动重画）。
            await core(['review', 'confirm', 'rv-main', 'R1-2', 'valid', '--by', 'lead'], repo);
            await wait(`document.querySelector(${jsonStr(last)}) !== window.__ar244Node`, `UI30 244 ${where}流水线刷新重画`, 20000);
            await check(`UI30 244 ${where}流水线：同任务刷新后保留横向位置，焦点回到原来的末节点并仍可见`, `(() => { const tr = document.querySelector(${jsonStr(track)}), a = document.activeElement, node = tr.querySelector('.node:last-of-type'); const r = node.getBoundingClientRect(), t = tr.getBoundingClientRect(); return a === node && Math.abs(tr.scrollLeft - ${before}) <= 1 && r.left >= t.left - 0.5 && r.right <= t.right + 0.5; })()`);
            await focusRing(`UI30 244 ${where}流水线末节点（刷新恢复后的焦点环）`);
            await key('Enter');
            const activated = kind === 'tasks' ? `document.querySelector('.dtabs [data-tab=flow]').classList.contains('on')` : `document.querySelector('[data-page=tasks]').getAttribute('aria-current') === 'page'`;
            await wait(activated, `UI30 244 ${where}流水线末节点回车激活`, 15000);
            await check(`UI30 244 ${where}流水线：末节点仍能用键盘激活原来的操作`, activated);
            await resize(1160, 720);
            await pause(350);
        };
        await trackHost('accept');
        await trackHost('tasks');
        // 回到验收页的审查标签，继续后面的成立 / 不成立检查。
        await selectAccept(M.id);
        await press('[data-atab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && document.querySelectorAll('[data-rv-card]').length === 4`, 'UI30 244 之后回到审查标签', 20000);

        // ================= 成立 / 不成立 =================
        await type('[data-rv-note="R1-3"]', '确实会越界');
        await press('button[data-rv-confirm="valid"][data-rv-issue="R1-3"]');
        await wait(`document.querySelector('[data-rv-card="R1-3"] [data-rv-conf]')?.dataset.rvConf === 'valid'`, 'UI30 点"成立"：卡片显示成立', 20000);
        await check('UI30 点"成立"后：卡片的标记是 rv.valid、"成立"按钮按下、说明框里的字还在；别的卡片没变', `(() => { const card = document.querySelector('[data-rv-card="R1-3"]'); return card.querySelector('[data-rv-conf]').textContent === ${jsonStr(rv.valid)} && card.querySelector('[data-rv-confirm=valid]').getAttribute('aria-pressed') === 'true' && card.querySelector('[data-rv-confirm=invalid]').getAttribute('aria-pressed') === 'false' && card.querySelector('[data-rv-note]').value === '确实会越界' && ['R1-4', 'R1-1'].every(id => !document.querySelector('[data-rv-card="' + id + '"] [data-rv-conf]')); })()`);
        await verify('UI30 清单里出现 review-confirm 事件（issue R1-3、result valid、by human、severity high、reviewer rev1），review.json 的确认带说明', async () => {
            const event = (await eventsOf(M.id)).filter(r => r.event === 'review-confirm' && r.issue === 'R1-3').at(-1);
            assert.deepEqual([event.result, event.by, event.severity, event.reviewer], ['valid', 'human', 'high', 'rev1']);
            const issue = (await reviewOf('rv-main')).issues.find((i: any) => i.id === 'R1-3');
            assert.deepEqual([issue.confirmation.result, issue.confirmation.by, issue.confirmation.note], ['valid', 'human', '确实会越界']);
        });
        await press('button[data-rv-confirm="invalid"][data-rv-issue="R1-3"]');
        await wait(`document.querySelector('[data-rv-card="R1-3"] [data-rv-conf]')?.dataset.rvConf === 'invalid'`, 'UI30 改点"不成立"：卡片显示不成立', 20000);
        await check('UI30 改点"不成立"：以最后一次为准，标记 rv.invalid、"不成立"按钮按下', `(() => { const card = document.querySelector('[data-rv-card="R1-3"]'); return card.querySelector('[data-rv-conf]').textContent === ${jsonStr(rv.invalid)} && card.querySelector('[data-rv-confirm=invalid]').getAttribute('aria-pressed') === 'true' && card.querySelector('[data-rv-confirm=valid]').getAttribute('aria-pressed') === 'false'; })()`);
        await verify('UI30 最后一条 R1-3 的 review-confirm 是 invalid（两次点击一共两条事件），核心的准确率按最后一次算：rev1 的高严重度已确认 1 条、成立 0 条', async () => {
            const events = (await eventsOf(M.id)).filter(r => r.event === 'review-confirm' && r.issue === 'R1-3');
            assert.deepEqual(events.map(r => r.result), ['valid', 'invalid']);
            const stats = (await core(['review', 'stats'])).reviewers.find((r: any) => r.reviewer === 'rev1');
            assert.deepEqual([stats.severities.high.confirmed, stats.severities.high.valid], [1, 0]);
        });
        await press('button[data-rv-confirm="valid"][data-rv-issue="R1-2"]');
        await wait(`document.querySelector('[data-rv-card="R1-2"] [data-rv-conf]')?.dataset.rvConf === 'valid'`, 'UI30 R1-2 成立', 20000);
        // 失败：review.json 暂时拿走，核心拒绝，卡片提示原因、显示不变。
        // 先等 R1-2 那次确认在界面里读完：清单里的确认时刻变了，审查标签会重读 review.json；这次重读若落在拿走之后就读失败，整个标签变成读不到、卡片没了。
        await pollUntil(async () => {
            await registry.refresh();
            const last = (await eventsOf(M.id)).filter(r => r.event === 'review-confirm').at(-1);
            return taskOf(M.id)?.review?.confirmedAt === last?.at;
        }, 20000);
        // 主进程读到之后，界面还要经过一次刷新（约 2 秒一轮）才发起重读并读完：多等两轮。
        await pause(4500);
        const savedReview = await readFile(reviewFile('rv-main'), 'utf8');
        await rm(reviewFile('rv-main'));
        await press('button[data-rv-confirm="valid"][data-rv-issue="R1-4"]');
        await wait(`!!document.querySelector('[data-rv-fail="R1-4"]')`, 'UI30 确认失败时卡片上显示原因', 20000);
        await check('UI30 确认失败：卡片上显示核心给的原因（非空，提到"审查结果"），这一条仍没有确认标记，按钮没有按下', `(() => { const card = document.querySelector('[data-rv-card="R1-4"]'); const fail = card.querySelector('[data-rv-fail]'); return fail.getAttribute('role') === 'alert' && fail.textContent.includes('审查结果') && !card.querySelector('[data-rv-conf]') && card.querySelector('[data-rv-confirm=valid]').getAttribute('aria-pressed') === 'false'; })()`);
        await writeFile(reviewFile('rv-main'), savedReview);
        await verify('UI30 失败时一条新的 review-confirm 都没写：R1-4 没有确认事件', async () => { assert.ok(!(await eventsOf(M.id)).some(r => r.event === 'review-confirm' && r.issue === 'R1-4')); });
        await verify('UI30 核心的准确率现在：rev1 已确认 2 条（高 1、中 1）、成立 1 条', async () => {
            const stats = (await core(['review', 'stats'])).reviewers.find((r: any) => r.reviewer === 'rev1');
            assert.deepEqual([stats.severities.high.confirmed + stats.severities.medium.confirmed, stats.severities.high.valid + stats.severities.medium.valid], [2, 1]);
        });

        // ================= 点文件:行：切到改动并滚到这一行 =================
        await press('button[data-rv-jump][data-rv-file="src/z.txt"]');
        await wait(`document.querySelector('[data-atab=diff]').classList.contains('on') && !!document.querySelector('.dl.rv-hit')`, 'UI30 点 src/z.txt:2：切到改动并标出这一行', 30000);
        await pause(300);
        await check('UI30 跳转到 src/z.txt 第 2 行：改动标签按下、z.txt 展开（它原来在默认展开的两个文件之后，是收起的）、标出的行是新文件的第 2 行（内容 Z2 changed）', `(() => { const hit = document.querySelector('.dl.rv-hit'); const box = hit.closest('[data-df-box]'); return document.querySelector('[data-atab=diff]').getAttribute('aria-pressed') === 'true' && box.querySelector('.df-h .p').textContent === 'src/z.txt' && box.querySelector('.df-h').getAttribute('aria-expanded') === 'true' && hit.querySelector('.no').textContent === '2' && hit.querySelector('.code').textContent.includes('Z2 changed') && !hit.classList.contains('del'); })()`);
        await check('UI30 这一行真的在视口里：滚动容器的 scrollTop 大于 0（前面两个展开的文件有 240 行），标出的行完整落在可视范围内', `(() => { const hit = document.querySelector('.dl.rv-hit'); const view = document.querySelector('.detail.acc .dbody .scroll'); const r = hit.getBoundingClientRect(), v = view.getBoundingClientRect(); return view.scrollTop > 0 && r.top >= v.top - 0.5 && r.bottom <= v.bottom + 0.5 && r.height > 0; })()`);
        await shots('review-jump');
        // 改动里没有这一行：滚到文件开头并提示一句。
        await press('[data-atab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && !!document.querySelector('[data-rv-jump]')`, 'UI30 回到审查标签');
        await press('button[data-rv-jump][data-rv-file="src/a.txt"][data-rv-line="500"]');
        await wait(`document.querySelector('[data-atab=diff]').classList.contains('on') && !!document.querySelector('.notice')`, 'UI30 点 src/a.txt:500：切到改动并提示', 30000);
        await check('UI30 改动里没有这一行（src/a.txt:500）：不标行，滚到 a.txt 的开头（文件头在视口里），提示一句', `(() => { const box = document.querySelector('[data-df-box="0"]'); const head = box.querySelector('.df-h'); const view = document.querySelector('.detail.acc .dbody .scroll'); const r = head.getBoundingClientRect(), v = view.getBoundingClientRect(); return head.querySelector('.p').textContent === 'src/a.txt' && !document.querySelector('.dl.rv-hit') && r.top >= v.top - 0.5 && r.top < v.top + v.height / 2 && document.querySelector('.notice').getAttribute('role') === 'status' && document.querySelector('.notice').textContent.includes('改动里没有这一行'); })()`);
        await press('[data-atab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && !!document.querySelector('[data-rv-jump]')`, 'UI30 回到审查标签（文件不在改动里）');
        await press('button[data-rv-jump][data-rv-file="docs/none.md"]');
        await wait(`document.querySelector('[data-atab=diff]').classList.contains('on') && !!document.querySelector('.notice')`, 'UI30 点 docs/none.md：切到改动并提示', 30000);
        await check('UI30 文件不在改动里（docs/none.md）：停在改动开头，不标行，同样提示一句', `!document.querySelector('.dl.rv-hit') && document.querySelector('.notice').textContent.includes('改动里没有这一行') && document.querySelectorAll('[data-df-box]').length === 3`);

        // ================= 再审一次 =================
        await press('[data-atab=review]');
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && !!document.querySelector('[data-rv-again]')`, 'UI30 回到审查标签（再审）');
        await press('[data-rv-again]');
        await wait('!!document.querySelector(".sheet [data-rv-pick]")', 'UI30 再审一次弹窗');
        await check('UI30 再审一次弹窗：标题 rv.againTitle、说明 rv.againHelp，审查者默认"按规则自动选"', `(() => { const s = document.querySelector('.sheet'); return s.querySelector('.sheet-h b').textContent === ${jsonStr(rv.againTitle)} && s.textContent.includes(${jsonStr(rv.againHelp)}) && s.querySelector('[data-rv-pick] span').textContent === ${jsonStr(rv.rerunAuto)}; })()`);
        await press('[data-rv-pick]');
        await wait('!!document.querySelector(".ctx")', 'UI30 审查者下拉');
        await check('UI30 审查者下拉：第一项"按规则自动选"，其余是可担任审查者、支持只读的执行者（含审查甲、审查乙）', `(() => { const items = [...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()); return items[0] === ${jsonStr(rv.rerunAuto)} && items.includes('审查甲') && items.includes('审查乙') && items.length >= 3; })()`);
        const pickIndex = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === '审查乙'); })()`);
        await press(`.ctx button[data-menu-index="${pickIndex}"]`);
        await wait(`document.querySelector('.sheet [data-rv-pick] span').textContent === '审查乙'`, 'UI30 选了审查乙');
        await press('.sheet [data-sheet-btn="1"]');
        await wait(`!document.querySelector('.sheet') && document.querySelector('[data-rv-again]')?.disabled === true`, 'UI30 确定后弹窗关闭、进行中按钮禁用', 20000);
        await wait(`document.querySelector('[data-rv-again]')?.disabled === false && document.querySelectorAll('[data-rv-card]').length === 2`, 'UI30 再审完成：按钮恢复、标签换成新结果', 120000);
        await check('UI30 再审完成后标签内容更新：审查者换成审查乙，卡片是 R1.2-1（中）、R1.2-2（低）；先前的确认不再显示（顶层 review.json 已换成最新一次）', `(() => { const cards = [...document.querySelectorAll('[data-rv-card]')]; return cards.map(c => c.dataset.rvCard).join() === 'R1.2-1,R1.2-2' && document.querySelector('[data-rv-head]').textContent.includes('审查乙') && !document.querySelector('[data-rv-conf]') && !document.querySelector('[data-rv-rerun-error]'); })()`);
        await verify('UI30 再审写了 attempts/1/review-2.json（run 2、审查者 rev2），顶层 review.json 换成最新的，清单多一条 run 为 2 的 review 事件，任务仍是待验收', async () => {
            const second = JSON.parse(await readFile(path.join(repo, '.agent-runs', 'rv-main', 'attempts', '1', 'review-2.json'), 'utf8'));
            assert.deepEqual([second.run, second.reviewer, second.issues.map((i: any) => i.id)], [2, 'rev2', ['R1.2-1', 'R1.2-2']]);
            assert.deepEqual((await reviewOf('rv-main')).issues.map((i: any) => i.id), ['R1.2-1', 'R1.2-2']);
            assert.ok((await eventsOf(M.id)).some(r => r.event === 'review' && r.run === 2 && r.reviewer === 'rev2'));
            await registry.refresh();
            assert.equal(worktreeState(taskOf(M.id)!), 'awaiting');
        });
        await wait(`document.querySelector('[data-acc="${M.id}"] [data-review-badge]')?.textContent.trim() === ${jsonStr(rv.badgeIssues(2))} && document.querySelector('.detail.acc .track .node[data-tab=review] .sub')?.textContent === ${jsonStr(rv.nodeIssues(2))}`, 'UI30 再审之后列表徽标与轨道节点换成新结果', 20000);
        await check('UI30 再审之后列表徽标、轨道节点都按新结果：2 个问题', `document.querySelector('[data-acc="${M.id}"] [data-review-badge]').textContent.trim() === ${jsonStr(rv.badgeIssues(2))} && document.querySelector('.detail.acc .track .node[data-tab=review] .sub').textContent === ${jsonStr(rv.nodeIssues(2))}`);
        await shots('review-again');

        // ================= 批准确认框里的未确认提示 =================
        await press('[data-acc-approve]');
        await wait('!!document.querySelector(".confirm-card")', 'UI30 批准确认框');
        await check('UI30 批准确认框：还有 1 个中问题（R1.2-1）没确认，多一句 rv.approveUnconfirmed(1, R1.2-1)；不拦着批准（"批准并合并"可点）', `(() => { const card = document.querySelector('.confirm-card'); const note = card.querySelector('[data-rv-approve-note]'); return note.textContent === ${jsonStr(rv.approveUnconfirmed(1, 'R1.2-1'))} && note.previousElementSibling.id === 'confirm-body' && !card.querySelector('.confirm-actions .btn.primary').disabled; })()`);
        await shots('review-approve');
        await key('Escape');
        await wait('!document.querySelector(".confirm-card")', 'UI30 取消批准');
        await verify('UI30 取消之后什么都没合并：任务仍是待验收', async () => { await registry.refresh(); assert.equal(worktreeState(taskOf(M.id)!), 'awaiting'); });

        // ================= 说明框的焦点保护（验收页）=================
        await wait(`document.querySelector('[data-atab=review]').classList.contains('on') && !!document.querySelector('[data-rv-note="R1.2-2"]')`, 'UI30 回到审查标签（焦点保护）');
        await type('[data-rv-note="R1.2-2"]', 'abc');
        await core(['review', 'confirm', 'rv-main', 'R1.2-1', 'valid', '--by', 'lead', '--note', '主导标的'], repo);
        await wait(`!!document.querySelector('[data-rv-card="R1.2-1"] [data-rv-conf="valid"]')`, 'UI30 审查标签刷新出 R1.2-1 已确认（lead 写的）', 20000);
        await check('UI30 审查结果更新（别处写了确认）触发刷新后，说明框保住焦点与已输入的内容：焦点仍在 R1.2-2 的说明框，文字 abc，光标在末尾；刷新出的那张卡片显示主导写的说明', `(() => { const a = document.activeElement; return a?.dataset.rvNote === 'R1.2-2' && a.value === 'abc' && a.selectionStart === 3 && a.selectionEnd === 3 && document.querySelector('[data-rv-note="R1.2-1"]').value === '主导标的'; })()`);
        // 已经有确认结果的问题：改说明后回车，按原来的结果连说明一起重新写（by 变成 human，因为是在软件里写的）。
        await type('[data-rv-note="R1.2-1"]', '补充');
        await key('Enter');
        await untilRow(async () => (await reviewOf('rv-main')).issues.find((i: any) => i.id === 'R1.2-1').confirmation.by === 'human' ? true : null, 'UI30 回车后说明写进了 review.json', 20000);
        await verify('UI30 回车把说明随确认一起写：R1.2-1 仍是 valid，说明是"主导标的补充"，by 变成 human；清单只多一条 review-confirm', async () => {
            const issue = (await reviewOf('rv-main')).issues.find((i: any) => i.id === 'R1.2-1');
            assert.deepEqual([issue.confirmation.result, issue.confirmation.by, issue.confirmation.note], ['valid', 'human', '主导标的补充']);
            assert.equal((await eventsOf(M.id)).filter(r => r.event === 'review-confirm' && r.issue === 'R1.2-1' && r.by === 'human').length, 1, '回车只写一次，失焦不重复提交');
        });
        await check('UI30 回车结束说明编辑：确认内容完整写入，焦点离开说明框，后续重画不把焦点带回说明框', `(() => { const a = document.activeElement, n = document.querySelector('[data-rv-note="R1.2-1"]'); return !!n && n.value === '主导标的补充' && a !== n && a?.dataset?.rvNote !== 'R1.2-1'; })()`);

        // ================= 需人工处理（拦截模式用完返工次数）=================
        const B = await dispatchTask('952-审查拦截', 'rv-block', 'blocker');
        await untilState(B.id, 'awaiting', 150000);
        await untilRow(async () => (await eventsOf(B.id)).find(r => r.event === 'review-needs-human'), '拦截任务写 review-needs-human', 30000);
        await verify('UI30 拦截任务：清单里 review → review-needs-human → end，review.json 写了 needsHuman: true，高严重度问题一个（R1-1）', async () => {
            const names2 = (await eventsOf(B.id)).map(r => r.event);
            assert.ok(names2.indexOf('review') < names2.indexOf('review-needs-human') && names2.indexOf('review-needs-human') < names2.indexOf('end'), names2.join());
            const review = await reviewOf('rv-block');
            assert.deepEqual([review.needsHuman, review.issues.map((i: any) => [i.id, i.severity])], [true, [['R1-1', 'high']]]);
            await registry.refresh();
            assert.equal(taskOf(B.id)!.review?.needsHuman, true);
        });
        await selectAccept(B.id);
        await wait(`!!document.querySelector('[data-rv-needs-human]')`, 'UI30 概览顶部出现需人工处理横幅', 20000);
        await check('UI30 需人工处理横幅：标题 rv.needsHuman、说明 rv.needsHumanHelp(R1-1)，在概览标签的顶部（各标签都有）', `(() => { const b = document.querySelector('[data-rv-needs-human]'); return b.classList.contains('fail') && b.querySelector('.rt b').textContent === ${jsonStr(rv.needsHuman)} && b.querySelector('.rt span').textContent === ${jsonStr(rv.needsHumanHelp('R1-1'))} && document.querySelector('[data-atab=overview]').classList.contains('on') && document.querySelector('.tab-body').firstElementChild === b; })()`);
        await press('[data-atab=gate]');
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.ok')`, 'UI30 门禁标签');
        await check('UI30 门禁标签顶部同样有需人工处理横幅', `!!document.querySelector('[data-rv-needs-human]')`);
        await press('[data-atab=review]');
        await wait(`!!document.querySelector('[data-rv-card="R1-1"]')`, 'UI30 拦截任务的审查标签');
        await shots('review-human');
        await press('button[data-rv-confirm="invalid"][data-rv-issue="R1-1"]');
        await wait(`document.querySelector('[data-rv-card="R1-1"] [data-rv-conf]')?.dataset.rvConf === 'invalid' && !document.querySelector('[data-rv-needs-human]')`, 'UI30 把唯一的高问题标成不成立后横幅消失', 20000);
        await check('UI30 高问题都被标成"不成立"之后需人工处理横幅消失（审查只是意见，可以直接批准）', `!document.querySelector('[data-rv-needs-human]')`);

        // ================= 审查进行中与"通过"的样子 =================
        // 第三个任务的审查者要 12 秒才给结论（结论是 pass，没有问题）：这期间任务状态仍是进行中，轨道"审查"节点是进行中，列表徽标是"审查中"。
        const S = await dispatchTask('953-审查进行中', 'rv-slow', 'slower');
        await untilRow(async () => (await eventsOf(S.id)).find(r => r.event === 'reviewing'), '慢任务写 reviewing 事件', 90000);
        await selectTask(S.id);
        await wait(`document.querySelectorAll('.track .node').length === 6 && document.querySelectorAll('.track .node')[3].classList.contains('running')`, 'UI30 审查进行中：轨道有审查节点且是进行中', 10000);
        await check('UI30 审查进行中：任务状态行仍是"进行中"、有"停止"按钮；轨道审查节点是进行中（小字 rv.nodeRunning、点它回进展）；列表行徽标是进行中样式的"审查中"；还没有"审查"标签', `(() => { const n = document.querySelectorAll('.track .node')[3]; const b = document.querySelector('[data-task="${S.id}"] .gbadge.running[data-review-badge]'); return document.querySelector('.dh-state').textContent.includes(${jsonStr(c.status.run)}) && !!document.querySelector('[data-stop]') && n.children[1].textContent === ${jsonStr(rv.node)} && n.querySelector('.sub').textContent === ${jsonStr(rv.nodeRunning)} && n.dataset.tab === 'flow' && b?.textContent.trim() === ${jsonStr(rv.nodeRunning)} && !document.querySelector('.dtabs [data-tab=review]'); })()`);
        await untilState(S.id, 'awaiting', 90000);
        await wait(`document.querySelectorAll('.track .node')[3]?.classList.contains('done')`, 'UI30 审查通过后轨道审查节点变成完成', 20000);
        await check('UI30 审查通过：轨道节点完成（小字 rv.nodePass）、列表徽标 rv.badge.pass（成功色）、详情多"审查"标签', `(() => { const n = document.querySelectorAll('.track .node')[3]; const b = document.querySelector('[data-task="${S.id}"] .gbadge[data-review-badge]'); return n.querySelector('.sub').textContent === ${jsonStr(rv.nodePass)} && n.dataset.tab === 'review' && b.classList.contains('ok') && b.textContent.trim() === ${jsonStr(rv.badge.pass)} && !!document.querySelector('.dtabs [data-tab=review]'); })()`);
        await press('.track .node[data-tab=review]');
        await wait(`document.querySelector('.dtabs [data-tab=review]').classList.contains('on') && !!document.querySelector('[data-rv-head]')`, 'UI30 通过任务的审查标签', 20000);
        await check('UI30 通过的审查标签：成功色横幅（标题 rv.verdict.pass）、没有问题卡片', `document.querySelector('[data-rv-head]').classList.contains('ok') && document.querySelector('[data-rv-head] .rt b').textContent === ${jsonStr(rv.verdict.pass)} && document.querySelectorAll('[data-rv-card]').length === 0`);
        // ================= 每页通用检查（审查标签）=================
        await audit('验收页审查标签', async () => { await openReviewTab(B.id); });
    }
    finally {
        if (await evaluate('!!document.querySelector(".sheet, .confirm-overlay, .ctx")').catch(() => false)) await key('Escape').catch(() => { });
        const hidden = await hiddenOf().catch(() => [] as string[]);
        await writeHidden([...hidden, ...originalHidden, ...touched.map(item => `${item.id}:${item.started}`)]).catch(() => { });
        // 全量验收里 UI31（路由页准确率，ar review stats）在本检查之后：UI30 写的确认事件只属于本检查派发的任务，
        // 检查完把它们从共享清单里去掉（只去这些任务 id 的 review-confirm 行，别的行不动），免得准确率从非空开始、
        // 把 UI31 的"还没有确认过"分支整条跳过（158 的门禁只单跑 --focus accept，没遇到这条顺序）。
        const ownIds = new Set(touched.map(item => item.id));
        if (ownIds.size) {
            const text = await readFile(registry.file, 'utf8').catch(() => null);
            if (text !== null) await writeFile(registry.file, text.split('\n').filter(line => {
                if (!line.includes('review-confirm')) return true;
                try { const row = JSON.parse(line); return !(row?.event === 'review-confirm' && ownIds.has(row.id)); } catch { return true; }
            }).join('\n')).catch(() => { });
        }
        if (registered) await coreRun(['projects', 'remove', repo], { timeoutMs: 60000 }).catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        win.setContentSize(1160, 720);
        nativeTheme.themeSource = 'dark';
    }
}
