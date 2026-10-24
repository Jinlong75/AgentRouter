import type { GateFile, GateResult, Task } from '../shared/types';
import { gt, rt } from '../shared/copy';
import { esc } from '../shared/markdown';
import { icon } from './ui';

// 门禁界面（Stage04，协议第 2 / 12 节）：任务页的流水线轨道前三段、列表徽标与"门禁"标签。
// 只按快照里 start.gate / gating / gate 与 detail 返回的 gate.json 渲染，不改核心与协议。
export type GateState = 'pending' | 'running' | 'ok' | 'fail' | 'notrun' | 'off';

// 任务的门禁状态：没有 gate 字段（直接文字、旧任务）返回 null，不画轨道也没有门禁标签。
// gate=false 表示说明派发时就没启用门禁（节点"未启用"）；gate=true 时按 gating / gate 事件推进。
export function gateState(t: Task): GateState | null {
    if (t.gate === undefined)
        return null;
    if (t.gate === false)
        return 'off';
    // Stage05：自动重试时第 2 次起的尝试进行中，快照里的 gateOk / gatingAt 还是上一次尝试的（清单解析不在尝试开始时清掉）：
    // 这一次的门禁还没开始就是"等待"，gating 事件晚于这次尝试开始才是"检查中"。
    if (t.status === 'run' && t.attempt && t.attempt.n > 1 && t.attempt.ok === undefined)
        return t.gatingAt !== undefined && t.gatingAt >= t.attempt.at ? 'running' : 'pending';
    if (t.gateOk !== undefined)
        return t.gateOk ? 'ok' : 'fail';
    if (t.gatingAt !== undefined)
        return t.status === 'run' ? 'running' : 'notrun';
    return t.status === 'run' ? 'pending' : 'notrun';
}
export function gateEnabled(t: Task) {
    return gateState(t) !== null && gateState(t) !== 'off';
}
export function gateFile(value: GateResult): GateFile | null {
    return value && typeof value === 'object' && !('error' in value) ? value as GateFile : null;
}
const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const elapsed = (t: Task) => { const seconds = Math.max(0, Math.floor((Date.now() - t.started) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
const okm = `<span class="mk ok">${icon('checkbox-circle-line')}</span>`;
const failm = `<span class="mk fail">${icon('close-circle-line')}</span>`;
const runm = `<span class="mk run">${icon('loader-4-line')}</span>`;

// 列表行第二行的徽标：只在门禁有结果或正在跑时出现。
export function gateBadge(t: Task) {
    const state = gateState(t);
    if (state !== 'ok' && state !== 'fail' && state !== 'running')
        return '';
    const map = { ok: ['ok', 'checkbox-circle-line'], fail: ['fail', 'close-circle-line'], running: ['running', 'loader-4-line'] } as const;
    const [cls, glyph] = map[state];
    return `<span class="gbadge ${cls}">${icon(glyph)}${esc(gt.badge[state])}</span>`;
}

// 轨道节点是真正的按钮：点派发 → 参数，点执行 → 进展，点门禁 → 门禁标签（未启用时回参数）。
export function trackNode(step: string, cls: string, glyph: string, sub: string, state: string, tab: string) {
    return `<button class="node ${cls}" data-tab="${tab}" aria-label="${esc(gt.nodeLabel(step, state))}" title="${esc(state)}"><span class="dot">${glyph}</span><span>${esc(step)}</span><span class="sub">${esc(sub)}</span></button>`;
}
// 执行、门禁两个节点的内容（样式类、图标、小字、aria 状态说明）；worktree 任务的五段轨道（wt.ts）也用它。state 是已经算好的门禁状态。
export function trackParts(t: Task, file: GateFile | null, state: GateState) {
    const exit = t.agentExit ?? t.exit ?? null;
    // Stage05：有多次尝试（当前尝试 total > 1）时，运行中写"第 n/N 次"，完成且不是第 1 次写"第 n 次完成"。
    const attempt = t.attempt, many = attempt && attempt.total && attempt.total > 1 ? attempt : null;
    const exec = t.status === 'stop' ? ['stopped', icon('stop-fill'), gt.trackStopped, '已中断']
        : t.status === 'run' ? ['running', '', many ? rt.trackRun(many.n, many.total!) : gt.trackRun, many ? rt.nodeRun(many.n, many.total!) : `运行中，已运行 ${elapsed(t)}`]
            : (state === 'notrun' || (t.agentExit !== undefined && t.agentExit !== 0) || (t.agentExit === undefined && t.exit !== 0))
                ? ['failed', icon('close-line'), gt.trackExit(exit), `异常退出（exit=${exit ?? '—'}）`]
                : attempt && attempt.n > 1 ? ['done', icon('check-line'), rt.trackDone(attempt.n), rt.nodeDone(attempt.n)]
                    : ['done', icon('check-line'), '完成', '执行者正常结束'];
    const commands = file?.commands ?? [], passed = commands.filter(command => command.exit === 0 && !command.timedOut && command.error == null).length;
    const summary = t.gateSummary ?? file?.summary ?? '';
    const gate = state === 'pending' ? ['todo', '', gt.trackGateWait, '执行者结束后运行', '等待']
        : state === 'running' ? ['running', '', gt.trackGating, '门禁进行中', '检查中']
            : state === 'ok' ? ['done', icon('check-line'), gt.trackGateOk(passed, commands.length), `门禁通过，${commands.length} 条命令全部通过`, '门禁通过']
                : state === 'fail' ? ['failed', icon('close-line'), gt.trackGateFail, `门禁未通过：${summary}`, '门禁未通过']
                    : state === 'off' ? ['skip', '', gt.trackGateOff, '这个任务没有启用门禁', '未启用']
                        : ['todo', '', '未运行', '执行者没有正常结束，门禁没有运行', '未运行'];
    return { exec, gate };
}
export function gateTrack(t: Task, file: GateFile | null) {
    const state = gateState(t);
    if (state === null)
        return '';
    const { exec, gate } = trackParts(t, file, state);
    const link2 = state === 'ok' || state === 'fail' || state === 'running' ? 'done' : '';
    return `<div class="track" role="group" aria-label="流水线">${trackNode(gt.track.dispatch, 'done', icon('check-line'), clock(t.started), `${clock(t.started)} 派发`, 'params')}<span class="link done"></span>${trackNode(gt.track.run, exec[0], exec[1], exec[2], exec[3], 'flow')}<span class="link ${link2}"></span>${trackNode(gt.track.gate, gate[0], gate[1], gate[2], `${gate[3]}，${gate[4]}`, state === 'off' ? 'params' : 'gate')}</div>`;
}

const gms = (ms: number) => gt.ms(ms);
const commandOk = (command: { exit: number | null; timedOut?: boolean; error?: string | null }) => command.exit === 0 && !command.timedOut && command.error == null;
const seconds = (ms: number | undefined) => Number.isFinite(ms) ? ((ms as number) / 1000).toFixed(1) : '—';

// "门禁"标签：横幅 → 提交检查 → 未提交的文件 → 改动范围 → 删除的文件（旧记录没有时整块不显示）→ 验收命令。
// 命令行沿用时间线的 .cmd / .out 组件；这里用 data-gcmd / data-gout，不与时间线的 data-cmd 混用。
// Stage05：attempt 是下拉选中的某一次尝试。读到了那一次的 gate.json 就直接显示它（不看任务当前的门禁状态）；
// 没读到时，最新一次仍按任务状态显示（进行中、等待…），更早的一次说明门禁没有结果。
export function gateTab(t: Task, file: GateFile | null, result: GateResult, attempt?: { latest: boolean; exit?: number | null }): string {
    const state = attempt && result ? null : gateState(t);
    if (attempt && !result && !attempt.latest)
        return attempt.exit
            ? `<div class="empty">${icon('shield-check-line')}<b>门禁没有运行</b><p>执行者没有正常结束（exit=${esc(attempt.exit)}），门禁只在执行者以 0 退出后运行。</p></div>`
            : `<div class="empty">${icon('shield-check-line')}<b>${esc(gt.missing)}</b></div>`;
    if (state === 'running')
        return `<div class="banner info" role="status">${runm}<div class="rt"><b>${esc(gt.runningTitle)}</b><span>${esc(gt.runningHelp(0))}</span></div></div><div class="empty">${runm}<b>${esc(gt.pending)}</b></div>`;
    if (state === 'pending')
        return `<div class="empty">${icon('shield-check-line')}<b>${esc(gt.pending)}</b><p>执行者以 0 退出后，核心会检查提交与改动范围，并逐条运行验收命令。</p></div>`;
    if (state === 'notrun')
        return `<div class="empty">${icon('shield-check-line')}<b>门禁没有运行</b><p>执行者没有正常结束（exit=${esc(t.agentExit ?? t.exit ?? '—')}），门禁只在执行者以 0 退出后运行。</p></div>`;
    if (result && typeof result === 'object' && 'error' in result)
        return `<div class="empty">${icon('shield-check-line')}<b>【文案待定：门禁结果无法读取】</b><p>${esc(result.error)}</p></div>`;
    if (!file)
        return `<div class="empty">${icon('shield-check-line')}<b>${esc(gt.missing)}</b></div>`;
    const commands = file.commands ?? [], outside = file.scope?.outside ?? [], changed = file.scope?.changed ?? [], uncommitted = file.uncommitted ?? [];
    const protectedPaths = file.scope?.protected ?? [];
    const deletedRaw = file.scope?.deleted;
    const deleted = Array.isArray(deletedRaw) ? deletedRaw : null;
    const head = file.ok
        ? `<div class="banner ok" role="status">${okm}<div class="rt"><b>${esc(gt.okTitle(3, commands.length, seconds(file.ms)))}</b><span>执行者结束后，核心自己检查了提交、未提交的文件与改动范围，并运行了验收命令。</span></div></div>`
        : `<div class="banner fail" role="alert">${failm}<div class="rt"><b>${esc(gt.failTitle)}</b><span>${esc(file.summary ?? '')}</span></div></div>`;
    const row = (ok: boolean, value: string, meta = '', mono = false, note = '') => `<div class="grow ${ok ? '' : 'bad'}">${ok ? okm : failm}<span class="v ${mono ? 'mono' : ''}">${value}${note ? `<span class="note">${note}</span>` : ''}</span><span class="meta">${esc(meta)}</span></div>`;
    const base = file.base ?? '', commitHead = file.head ?? '';
    const commit = file.commit?.required
        ? row(file.commit.ok !== false, `${esc(gt.commitRequired)} · ${file.commit.ok === false ? esc(gt.commitNone) : esc(gt.commitOk(base, commitHead))}`)
        : row(true, esc(gt.commitNotRequired));
    const unc = uncommitted.length ? uncommitted.map(path => row(false, esc(path), '', true)).join('') : row(true, esc(gt.uncommittedNone), '', false, esc(gt.uncommittedHelp));
    const allowed = file.scope?.allowed ?? [];
    const scope = `<div class="gallow"><span>${esc(gt.scopeAllowed)}</span>${allowed.length ? allowed.map(allowedPath => `<span class="mono">${esc(allowedPath)}</span>`).join('<span>·</span>') : `<span>${esc(gt.scopeAll)}</span>`}</div>` + (changed.length ? changed.map(path => row(!outside.includes(path), esc(path), protectedPaths.includes(path) ? gt.scopeProtected : outside.includes(path) ? gt.scopeOutside : '', true)).join('') : row(true, esc(gt.scopeNone)));
    // 删除的文件（界面稿 gateTab）：只是提示，图标与文字用次级色；旧记录没有 deleted 字段时整块不显示。
    const del = deleted === null ? '' : `<div class="sec-t">${esc(gt.deletedSec)}<span class="sp"></span><span>${deleted.length ? esc(gt.deletedCount(deleted.length)) : ''}</span></div>`
        + (deleted.length
            ? deleted.map(path => `<div class="grow info">${icon('delete-bin-line')}<span class="v mono">${esc(path)}</span><span class="meta">${outside.includes(path) ? esc(gt.scopeOutside) : ''}</span></div>`).join('')
            : `<div class="grow info">${icon('delete-bin-line')}<span class="v">${esc(gt.deletedNone)}<span class="note">${esc(gt.deletedNoneHelp)}</span></span><span class="meta"></span></div>`);
    // 工作区外的新文件（协议 12.4，Stage06）：放在"改动范围"（含删除的文件）后面；有新文件标红，
    // 没能核对时用次级色的提示行；旧记录没有 outsideWrites 字段，整块不显示。
    const outsideWrites = file.outsideWrites, outsideAdded = Array.isArray(outsideWrites?.added) ? outsideWrites.added : [];
    const outsideBlock = outsideAdded.length
        ? `<div class="sec-t" data-outside-sec>${esc(rt.outsideGate)}</div>` + outsideAdded.map(item => `<div class="grow bad" data-outside-item>${failm}<span class="v mono">${esc(item.name)}</span><span class="meta">${esc(rt.outsideRoot[item.root] ?? item.root)}</span></div>`).join('')
        : outsideWrites?.checked === false
            ? `<div class="grow info" data-outside-unchecked>${icon('information-line')}<span class="v">${esc(rt.outsideUnchecked(outsideWrites.error ?? ''))}</span><span class="meta"></span></div>`
            : '';
    const cmds = commands.length ? commands.map((command, index) => {
        const meta = [command.timedOut ? gt.timedOut : command.exit ? `exit=${command.exit}` : '', gms(command.ms ?? 0)].filter(Boolean).join(' · ');
        const errorNote = command.error ? `<span class="note">${esc(command.error)}</span>` : '';
        return `<div class="grow ${commandOk(command) ? '' : 'bad'}">${commandOk(command) ? okm : failm}<span class="v"><button class="cmd" data-gcmd="${index}" aria-expanded="false">${command.output ? icon('arrow-right-s-line') : ''}<code>${esc(command.line)}</code></button>${command.output ? `<pre class="out selectable" data-gout="${index}" hidden>${esc(command.output)}</pre>${command.truncated ? `<span class="note" data-gnote="${index}" hidden>${esc(gt.truncated)}</span>` : ''}` : errorNote}</span><span class="meta">${esc(meta)}</span></div>`;
    }).join('') : row(true, esc(gt.commandsNone));
    return `${head}<div class="sec-t">${esc(gt.commitSec)}</div>${commit}<div class="sec-t">${esc(gt.uncommittedSec)}</div>${unc}<div class="sec-t">${esc(gt.scopeSec)}<span class="sp"></span><span>${esc(gt.scopeCount(changed.length, outside.length))}</span></div>${scope}${del}${outsideBlock}<div class="sec-t">${esc(gt.commandsSec)}</div>${cmds}`;
}
