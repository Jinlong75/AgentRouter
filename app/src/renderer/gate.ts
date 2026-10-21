import type { GateFile, GateResult, Task } from '../shared/types';
import { gt } from '../shared/copy';
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
function trackNode(step: string, cls: string, glyph: string, sub: string, state: string, tab: string) {
    return `<button class="node ${cls}" data-tab="${tab}" aria-label="${esc(gt.nodeLabel(step, state))}" title="${esc(state)}"><span class="dot">${glyph}</span><span>${esc(step)}</span><span class="sub">${esc(sub)}</span></button>`;
}
export function gateTrack(t: Task, file: GateFile | null) {
    const state = gateState(t);
    if (state === null)
        return '';
    const exit = t.agentExit ?? t.exit ?? null;
    const exec = t.status === 'stop' ? ['stopped', icon('stop-fill'), gt.trackStopped, '已中断']
        : t.status === 'run' ? ['running', '', gt.trackRun, `运行中，已运行 ${elapsed(t)}`]
            : (state === 'notrun' || (t.agentExit !== undefined && t.agentExit !== 0) || (t.agentExit === undefined && t.exit !== 0))
                ? ['failed', icon('close-line'), gt.trackExit(exit), `异常退出（exit=${exit ?? '—'}）`]
                : ['done', icon('check-line'), '完成', '执行者正常结束'];
    const commands = file?.commands ?? [], passed = commands.filter(command => command.exit === 0 && !command.timedOut && command.error == null).length;
    const summary = t.gateSummary ?? file?.summary ?? '';
    const gate = state === 'pending' ? ['todo', '', gt.trackGateWait, '执行者结束后运行', '等待']
        : state === 'running' ? ['running', '', gt.trackGating, '门禁进行中', '检查中']
            : state === 'ok' ? ['done', icon('check-line'), gt.trackGateOk(passed, commands.length), `门禁通过，${commands.length} 条命令全部通过`, '门禁通过']
                : state === 'fail' ? ['failed', icon('close-line'), gt.trackGateFail, `门禁未通过：${summary}`, '门禁未通过']
                    : state === 'off' ? ['skip', '', gt.trackGateOff, '这个任务没有启用门禁', '未启用']
                        : ['todo', '', '未运行', '执行者没有正常结束，门禁没有运行', '未运行'];
    const link2 = state === 'ok' || state === 'fail' || state === 'running' ? 'done' : '';
    return `<div class="track" role="group" aria-label="流水线">${trackNode(gt.track.dispatch, 'done', icon('check-line'), clock(t.started), `${clock(t.started)} 派发`, 'params')}<span class="link done"></span>${trackNode(gt.track.run, exec[0], exec[1], exec[2], exec[3], 'flow')}<span class="link ${link2}"></span>${trackNode(gt.track.gate, gate[0], gate[1], gate[2], `${gate[3]}，${gate[4]}`, state === 'off' ? 'params' : 'gate')}</div>`;
}

const gms = (ms: number) => gt.ms(ms);
const commandOk = (command: { exit: number | null; timedOut?: boolean; error?: string | null }) => command.exit === 0 && !command.timedOut && command.error == null;
const seconds = (ms: number | undefined) => Number.isFinite(ms) ? ((ms as number) / 1000).toFixed(1) : '—';

// "门禁"标签：横幅 → 提交检查 → 未提交的文件 → 改动范围 → 验收命令。
// 命令行沿用时间线的 .cmd / .out 组件；这里用 data-gcmd / data-gout，不与时间线的 data-cmd 混用。
export function gateTab(t: Task, file: GateFile | null, result: GateResult): string {
    const state = gateState(t);
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
    const scope = `<div class="gallow"><span>${esc(gt.scopeAllowed)}</span>${allowed.length ? allowed.map(allowedPath => `<span class="mono">${esc(allowedPath)}</span>`).join('<span>·</span>') : `<span>${esc(gt.scopeAll)}</span>`}</div>` + (changed.length ? changed.map(path => row(!outside.includes(path), esc(path), outside.includes(path) ? gt.scopeOutside : '', true)).join('') : row(true, esc(gt.scopeNone)));
    const cmds = commands.length ? commands.map((command, index) => {
        const meta = [command.timedOut ? gt.timedOut : command.exit ? `exit=${command.exit}` : '', gms(command.ms ?? 0)].filter(Boolean).join(' · ');
        const errorNote = command.error ? `<span class="note">${esc(command.error)}</span>` : '';
        return `<div class="grow ${commandOk(command) ? '' : 'bad'}">${commandOk(command) ? okm : failm}<span class="v"><button class="cmd" data-gcmd="${index}" aria-expanded="false">${command.output ? icon('arrow-right-s-line') : ''}<code>${esc(command.line)}</code></button>${command.output ? `<pre class="out selectable" data-gout="${index}" hidden>${esc(command.output)}</pre>${command.truncated ? `<span class="note" data-gnote="${index}" hidden>${esc(gt.truncated)}</span>` : ''}` : errorNote}</span><span class="meta">${esc(meta)}</span></div>`;
    }).join('') : row(true, esc(gt.commandsNone));
    return `${head}<div class="sec-t">${esc(gt.commitSec)}</div>${commit}<div class="sec-t">${esc(gt.uncommittedSec)}</div>${unc}<div class="sec-t">${esc(gt.scopeSec)}<span class="sp"></span><span>${esc(gt.scopeCount(changed.length, outside.length))}</span></div>${scope}<div class="sec-t">${esc(gt.commandsSec)}</div>${cmds}`;
}
