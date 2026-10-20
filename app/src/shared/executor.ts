import type { Task } from './types';

// 执行者的显示：名字来自 start 行的 label（派发时的执行者显示名）；旧记录没有时按适配器名（旧任务都是 Codex）。
// 这里只认适配器（程序）名，不写任何服务商或模型名（D17、O10）。
const adapterNames: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };
export const executorAdapter = (t: Task) => t.adapter ?? t.agent ?? 'codex';
export const executorLabel = (t: Task) => t.label ?? adapterNames[executorAdapter(t)] ?? t.profile ?? executorAdapter(t);
export const isCodexTask = (t: Task) => executorAdapter(t) === 'codex';

// 列表行的执行者标签（VisualSpec 4.3：2～3 个字母）：名字第一个词里的大写字母（如 "ExampleAgent" → EA），不足两个时取前两个字母。
export function executorTag(label: string) {
    const first = label.trim().split(/[\s（(·]/)[0] ?? '';
    const caps = first.replace(/[^A-Z]/g, '');
    if (caps.length >= 2) return caps.slice(0, 3);
    return (first.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || label.trim().slice(0, 2)).toUpperCase();
}
