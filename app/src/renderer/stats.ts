import { statsCopy as c } from '../shared/copy';
import { esc } from '../shared/markdown';
import { icon } from './ui';

type Range = '7d' | '30d' | 'all';
type Price = { input: number; output: number; currency: string };
// 427：列头的说明与方向（越高 / 越低越好）。
type Head = { label: string; help?: string; dir?: 'up' | 'down' };
const val = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '—';
const duration = (v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const minutes = Math.floor(v / 60000);
    return minutes < 1 ? '不到 1 分' : minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
};
const token = (v: unknown) => typeof v !== 'number' || !Number.isFinite(v) ? '—' : v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
const pct = (r: any, weak = false) => {
    if (r?.value == null) return '—';
    const lo = r.wilson95 ? Math.round(r.wilson95.low * 100) : null, hi = r.wilson95 ? Math.round(r.wilson95.high * 100) : null;
    return `<span class="stat-ratio${weak ? ' weak' : ''}"><b>${Math.round(r.value * 100)}%</b>${r.wilson95 ? `<span class="ci" title="${esc(c.ciTitle(lo!, hi!))}">${lo}–${hi}%</span>` : ''}</span>`;
};
const money = (v: Record<string, number> | null) => v && Object.keys(v).length ? Object.entries(v).map(([currency, n]) => `${currency} ${val(n)}`).join(' · ') : '—';
const tip = (reason: string) => ` data-tip="${esc(reason)}"`;
const cell = (v: unknown, reason = c.tipMissing) => `<td${String(v ?? '—').includes('—') ? tip(reason) : ''}>${esc(String(v ?? '—'))}</td>`;
const ratioCell = (r: any, weak = false) => `<td${r?.value == null ? tip(r?.denominator === 0 ? c.tipZero : c.tipMissing) : ''}>${pct(r, weak)}</td>`;
// 列头：悬停 title、可见且可聚焦的问号（aria-describedby 指向说明原文）、方向箭头。
const table = (label: string, key: string, headings: Head[], rows: string[]) => `<div class="card stat-tw"><table class="stat-tbl" aria-label="${esc(label)}"><thead><tr>${headings.map((h, i) => {
    const id = `stat-help-${key}-${i}`, arrow = h.dir === 'up' ? 'arrow-up-line' : 'arrow-down-line', dirText = h.dir === 'up' ? c.higher : c.lower;
    return `<th${h.help ? ` title="${esc(h.help)}"` : ''}>${esc(h.label)}${h.dir ? `<span class="stat-dir" role="img" aria-label="${esc(dirText)}" title="${esc(dirText)}">${icon(arrow)}</span>` : ''}${h.help ? `<button type="button" class="stat-help" aria-label="${esc(c.helpPrefix + h.label)}" aria-describedby="${id}">${icon('information-line')}</button><span class="stat-help-text" id="${id}">${esc(h.help)}</span>` : ''}</th>`;
}).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

export class StatsView {
    private host: HTMLElement | null = null;
    private range: Range = '7d';
    private project = '';
    private serial = 0;
    private data: any = null;
    private projects: string[] = [];
    private agents: { name: string; label: string }[] = [];
    private prices: Record<string, Price> = {};
    private editing = '';
    private error = '';
    constructor(private newTask: () => void) {}
    mount(host: HTMLElement) { this.host = host; this.render(); void this.load(); }
    unmount() { this.host = null; this.serial++; }
    private async load() {
        const id = ++this.serial, range = this.range, project = this.project;
        try {
            const [all, data, agents, config] = await Promise.all([
                window.dock.console('stats:get', { range }),
                project ? window.dock.console('stats:get', { range, project }) : Promise.resolve(null),
                window.dock.console('agents:list'), window.dock.console('stats:config')
            ]);
            if (id !== this.serial || !this.host) return;
            this.projects = all.projects ?? []; this.data = data ?? all;
            this.agents = agents.agents ?? []; this.prices = config.config?.prices ?? {}; this.error = '';
            this.render();
        } catch (e) { if (id !== this.serial || !this.host) return; this.data = null; this.error = String((e as Error).message ?? e); this.render(); }
    }
    private render() {
        if (!this.host) return;
        const d = this.data, o = d?.overall;
        const section = (title: string, help: string, body: string) => `<div class="sect"><h2>${esc(title)}</h2><p>${esc(help)}</p>${body}</div>`;
        const kpi = (label: string, v: string, reason = c.tipMissing, sub = '') => `<div class="kpi"><span class="lb">${esc(label)}</span><span class="v mono"${v === '—' ? tip(reason) : ''}>${esc(v)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;
        const head = `<div class="page-h sticky"><h1>${c.statsTitle}</h1><span class="sp"></span><div class="segm" role="group" aria-label="${c.range}">${([['7d', c.statsRange7], ['30d', c.statsRange30], ['all', c.statsRangeAll]] as const).map(([r, label]) => `<button data-stat-range="${r}" class="${this.range === r ? 'on' : ''}">${label}</button>`).join('')}</div><select class="sel" data-stat-project aria-label="${c.statsAllProjects}"><option value="">${c.statsAllProjects}</option>${this.projects.map(p => `<option value="${esc(p)}" ${p === this.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>`;
        let body = '';
        // 427：来源行按实际读到的额外目录数显示（extraSources，不含公共目录与旧目录；被跳过的不算），有跳过的额外目录时追加说明。
        const extraRead = Array.isArray(d?.extraSources) ? d!.extraSources.length : 0;
        const skipped = Array.isArray(d?.skippedSources) ? d!.skippedSources.length : 0;
        if (d && (extraRead || skipped)) body += `<p class="stat-source muted">${esc(c.sourcesLine(extraRead))}<button class="btn quiet sm" data-stat-sources-manage>${esc(c.sourcesManage)}</button>${skipped ? ` ${esc(c.sourcesSkipped(skipped))}` : ''}</p>`;
        if (this.error) body += `<div role="alert">${esc(this.error)} <button class="btn sm" data-stat-retry>${c.statsRetry}</button></div>`;
        if (d && !d.totals?.tasks) body += `<div class="empty tall"><b>${c.statsEmpty}</b><p>${c.statsEmptyBody}</p><button class="btn primary sm" data-stat-new>${c.statsNewTask}</button></div>`;
        if (d && d.totals?.tasks) {
            body += section(c.statsOverall, c.overallHelp, `<div class="card"><div class="card-b kpis">${kpi(c.weekly, val(o.weeks?.at(-1)?.merged), c.tipMissing, c.statsLatestWeek)}${kpi(c.duration, duration(o.medianEndToEndMs))}${kpi(c.interventions, val(o.humanInterventions?.total))}${kpi(c.totalCost, money(o.cost), c.tipCost)}${kpi(c.ratio, val(o.leadExecutorTokenRatio), c.tipLead)}</div></div>`);
            const rows = (d.strata ?? []).map((s: any) => { const e = s.executor; return `<tr>${cell(s.profile)}${cell(s.type)}${cell(s.effort)}${cell(s.sampleSize).replace('</td>', `${s.insufficient ? ` <span class="tag">${c.statsInsufficient}</span>` : ''}</td>`)}${ratioCell(e.firstPass, s.insufficient)}${cell(val(e.avgAttempts))}${ratioCell(e.outsideRate, s.insufficient)}${ratioCell(e.escalationRate, s.insufficient)}${cell(duration(e.medianMs))}${cell(c.tokensCell(token(e.tokensPerMerged?.input), token(e.tokensPerMerged?.output)))}${cell(money(e.costPerMerged), c.tipCost)}</tr>`; });
            const executorHeads: Head[] = [
                { label: c.statsExecutor, help: c.helpExecutorCol }, { label: c.type, help: c.helpTypeCol }, { label: c.effort, help: c.helpEffortCol },
                { label: c.sample, help: c.helpSampleCol }, { label: c.firstPass, help: c.helpFirstPassCol, dir: 'up' },
                { label: c.attempts, help: c.helpAttemptsCol, dir: 'down' }, { label: c.outside, help: c.helpOutsideCol, dir: 'down' },
                { label: c.escalation, help: c.helpEscalationCol, dir: 'down' }, { label: c.median, help: c.helpMedianCol, dir: 'down' },
                { label: c.tokens, help: c.helpTokensCol, dir: 'down' }, { label: c.cost, help: c.helpCostCol, dir: 'down' },
            ];
            const how = `<details class="sc-how" data-stat-how><summary>${icon('question-line')}${esc(c.howSummary)}</summary><p>${esc(c.howText)}</p></details>`;
            body += section(c.statsExecutor, c.executorHelp, how + table(c.executorTable, 'exec', executorHeads, rows));
            body += section(c.statsReviewer, c.reviewerHelp, `<div class="stat-review-empty">${c.statsNoReviewerGroups}</div>`);
            const leadHeads: Head[] = [{ label: c.leadName, help: c.helpLeadNameCol }, { label: c.specFailure, help: c.helpSpecFailureCol, dir: 'down' }, { label: c.supplement, help: c.helpSupplementCol, dir: 'down' }, { label: c.mergeMedian, help: c.helpMergeMedianCol, dir: 'down' }];
            body += section(c.statsLead, c.leadHelp, table(c.leadTable, 'lead', leadHeads, (d.leadGroups ?? []).map((g: any) => `<tr>${cell(`${g.label ?? c.unrecorded} · ${g.model ?? c.unrecorded}`)}${ratioCell(g.lead.specGateFailureRate)}${cell(val(g.lead.supplementCount))}${cell(duration(g.lead.dispatchToMergeMedianMs))}</tr>`)));
            const daily: any[] = d.daily ?? [], max = Math.max(1, ...daily.flatMap(x => [x.tasks, x.accepted])), step = 734 / Math.max(1,daily.length), x = (i: number) => 18 + step * (i + .5), y = (n: number) => 150 - n / max * 138;
            const tip = (a: any) => `${a.date} · ${c.task} ${a.tasks} · ${c.pass} ${a.accepted}`;
            const chart = `<div class="card"><div class="stat-legend">${c.tasks} · ${c.accepted}</div><div class="stat-chart"><svg viewBox="0 0 760 180" role="img" aria-label="${c.trendLabel}">${daily.map((a,i) => `<rect class="tr-bar" x="${x(i)-Math.min(20,step*.46)/2}" y="${y(a.tasks)}" width="${Math.min(20,step*.46)}" height="${150-y(a.tasks)}" data-tip="${esc(tip(a))}"><title>${esc(tip(a))}</title></rect>`).join('')}<path class="tr-line" d="${daily.map((a,i) => `${i ? 'L' : 'M'}${x(i)} ${y(a.accepted)}`).join(' ')}"></path>${daily.map((a,i) => `<circle class="tr-dot" cx="${x(i)}" cy="${y(a.accepted)}" r="3" data-tip="${esc(tip(a))}"><title>${esc(tip(a))}</title></circle><text class="tr-date" x="${x(i)}" y="170" text-anchor="middle">${esc(a.date)}</text>`).join('')}</svg></div></div>`;
            body += section(c.statsTrend, c.trendHelp, chart);
        }
        const prices = this.agents.map(a => { const p = this.prices[a.name], edit = this.editing === a.name; return `<div class="price-row" data-price-row="${esc(a.name)}"><span class="px-name"><b>${esc(a.label || a.name)}</b></span><span class="px-vals">${edit ? `${c.statsInput} <input class="inp" data-price-input value="${esc(String(p?.input ?? ''))}"> ${c.statsOutput} <input class="inp" data-price-output value="${esc(String(p?.output ?? ''))}">` : p ? `${c.statsInput} ${esc(String(p.input))} · ${c.statsOutput} ${esc(String(p.output))}` : c.statsUnset} ${c.statsPerMillion}</span>${edit ? `<select class="sel" data-price-currency><option ${p?.currency !== 'USD' ? 'selected' : ''}>CNY</option><option ${p?.currency === 'USD' ? 'selected' : ''}>USD</option></select>` : esc(p?.currency ?? '')}<span class="px-act">${edit ? `<button class="btn sm" data-price-cancel>${c.statsCancel}</button><button class="btn sm" data-price-clear>${c.clear}</button><button class="btn sm primary" data-price-save>${c.statsSave}</button>` : `<button class="btn sm" data-price-edit>${c.statsEdit}</button>`}</span></div>`; }).join('');
        if (d) body += section(c.statsPrice, c.priceHelp, `<div class="card"><div class="card-h"><b>${c.statsUnitPrice}</b> ${!Object.keys(this.prices).length ? c.statsNoPrice : ''}</div><div class="card-b">${prices}</div></div>`);
        this.host.innerHTML = `<div class="doc scroll">${head}<div class="doc-in">${body}</div></div>`;
        this.host.onclick = e => { const t = e.target as HTMLElement, range = t.closest<HTMLElement>('[data-stat-range]')?.dataset.statRange as Range | undefined, row = t.closest<HTMLElement>('[data-price-row]'); if (range) { this.range = range; void this.load(); } else if (t.closest('[data-stat-retry]')) void this.load(); else if (t.closest('[data-stat-sources-manage]')) { document.querySelector<HTMLElement>('.nav [data-page="settings"]')?.click(); window.dispatchEvent(new CustomEvent('ar:stats-sources')); } else if (t.closest('[data-stat-new]')) this.newTask(); else if (row && t.closest('[data-price-edit]')) { this.editing = row.dataset.priceRow!; this.render(); } else if (t.closest('[data-price-cancel]')) { this.editing = ''; this.render(); } else if (row && (t.closest('[data-price-save]') || t.closest('[data-price-clear]'))) { const input = row.querySelector<HTMLInputElement>('[data-price-input]')!.value, output = row.querySelector<HTMLInputElement>('[data-price-output]')!.value, currency = row.querySelector<HTMLSelectElement>('[data-price-currency]')!.value; void this.save(row.dataset.priceRow!, t.closest('[data-price-clear]') ? '' : `${input}/${output}/${currency}`, row); } };
        this.host.onchange = e => { const t = e.target as HTMLSelectElement; if (t.matches('[data-stat-project]')) { this.project = t.value; void this.load(); } };
        this.host.onkeydown = e => { if (e.key === 'Escape' && this.editing) { this.editing = ''; this.render(); } };
    }
    private async save(name: string, price: string, row: HTMLElement) {
        try { await window.dock.console('agents:update', { name, price }); this.editing = ''; await this.load(); }
        catch (e) { let alert = row.querySelector<HTMLElement>('[role=alert]'); if (!alert) { alert = document.createElement('span'); alert.setAttribute('role','alert'); row.append(alert); } alert.textContent = String((e as Error).message ?? e); }
    }
}
