import { summarizeGate } from '../../core/lib/gate.mjs';

const tasks = [
  { id: 't1', day: 'run', name: '012-背包拖拽与堆叠', project: 'pixel-garden', host: 'Claude Code', role: '执行者', state: 'run', start: '15:21', dur: '18:42', last: '运行：npm test -- inventory', sandbox: 'workspace-write' },
  { id: 't2', day: 'run', name: '007-搜索结果分页', project: 'notes-web', host: 'Claude Code', role: '执行者', state: 'run', start: '15:36', dur: '4:05', last: '修改文件：src/search/Results.tsx', sandbox: 'workspace-write' },
  { id: 't3', day: 'today', name: '011-存档版本迁移', project: 'pixel-garden', host: 'Claude Code', role: '执行者', state: 'done', start: '14:02', dur: '22.4 分钟', commit: '4f2a9c1', sandbox: 'workspace-write' },
  { id: 't4', day: 'today', name: '排查启动时白屏', record: 'task-20261008-1310', project: 'notes-web', host: 'Claude Code', role: null, state: 'done', start: '13:10', dur: '6.1 分钟', sandbox: 'read-only' },
  // Stage04：执行者自己失败、但说明本来会跑门禁的任务——执行节点异常退出，门禁节点"未运行"。
  { id: 't5', day: 'today', name: '006-导出 PDF', project: 'notes-web', host: 'Claude Code', role: '执行者', executor: { profile: 'deepseek', adapter: 'claude-code', label: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', agentVersion: '2.1.302 (Claude Code)' }, state: 'fail', exit: 1, start: '11:47', dur: '9.8 分钟', sandbox: 'workspace-write', gate: true, base: 'main' },
  { id: 't6', day: 'today', name: '010-粒子特效对象池', project: 'pixel-garden', host: 'Claude Code', role: '执行者', state: 'stop', start: '10:05', dur: '3.2 分钟', sandbox: 'workspace-write' },
  { id: 't10', day: 'today', name: '013-粒子对象池重构', project: 'notes-web', host: 'Claude Code', role: '执行者', state: 'stop', signal: 'stopped-by-app', start: '10:15', dur: '3.2 分钟', sandbox: 'workspace-write' },
  { id: 't7', day: 'yesterday', name: '009-地图分块加载', project: 'pixel-garden', host: 'Claude Code', role: '执行者', state: 'done', start: '17:40', dur: '31.0 分钟', commit: 'b81e0d2', sandbox: 'workspace-write' },
  { id: 't8', day: 'yesterday', name: '005-标签筛选', project: 'notes-web', host: 'Claude Code', role: '执行者', executor: { profile: 'deepseek', adapter: 'claude-code', label: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', agentVersion: '2.1.302 (Claude Code)' }, state: 'done', start: '16:12', dur: '12.7 分钟', commit: '3c09a7e', sandbox: 'workspace-write' },
  { id: 't9', day: 'yesterday', name: '008-音效总线', project: 'pixel-garden', host: 'Claude Code', role: '执行者', state: 'done', start: '11:03', dur: '15.5 分钟', commit: '90d4f1b', sandbox: 'workspace-write' },
  // 再派一次区分：同一份任务说明的原任务（已完成）和它的再派一次（记录名 -2），标题一样，界面按记录名区分。
  { id: 't11', day: 'today', name: '004-批量归档', project: 'notes-web', host: 'Claude Code', role: '执行者', state: 'done', start: '12:40', dur: '8.5 分钟', commit: 'e4c7b2a', sandbox: 'workspace-write' },
  { id: 't12', day: 'today', name: '004-批量归档', record: '004-批量归档-2', project: 'notes-web', host: 'Claude Code', role: '执行者', state: 'done', start: '12:52', dur: '6.2 分钟', commit: 'a1b2c3d', sandbox: 'workspace-write' },
  // 015：软件派发的任务（派活方字段 dispatcher 写 agentrouter，生成器写进 runs.jsonl 的 dispatcher.host）。
  // 没写这个字段的任务仍是 claude-code，原有演示任务的显示不变。
  { id: 't13', day: 'today', name: '014-批量重命名标签', project: 'notes-web', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', state: 'done', start: '13:22', dur: '6.8 分钟', commit: '7c3d15e', sandbox: 'workspace-write' },
  // Stage04 门禁演示（单独的 reader-app 项目，不影响原有任务数量）：
  // t20 门禁通过；t21 门禁未通过（越界文件 + 失败的截断命令，任务 exit=3 而执行者 agentExit=0）；
  // t22 说明派发但没启用门禁（gate:false）。
  { id: 't20', day: 'today', name: '020-导出书签', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'done', start: '09:20', dur: '7.4 分钟', commit: '7f0c9de', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't21', day: 'today', name: '021-导出筛选', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'fail', exit: 3, agentExit: 0, start: '09:05', dur: '6.1 分钟', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't22', day: 'today', name: '022-整理导出文档', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'done', start: '08:50', dur: '3.5 分钟', commit: '5b7e2c0', sandbox: 'workspace-write', gate: false, base: 'a1b2c3d' },
];

// 门禁结果（文件协议 12.3，写入任务记录目录的 gate.json）。at 由生成器按任务开始时间补。
const gates = {
  t20: {
    v: 1, attempt: 1, ms: 12400, ok: true, base: 'a1b2c3d', head: '7f0c9de',
    commit: { required: true, ok: true }, uncommitted: [],
    scope: { allowed: ['src/export/**', 'tests/export-*'], changed: ['src/export/bookmarks.ts', 'tests/export-bookmarks.test.ts'], outside: [] },
    commands: [
      { line: 'npm test -- export', argv: ['npm', 'test', '--', 'export'], exit: 0, ms: 8400, output: '✓ 导出书签为 JSON\n✓ 空书签导出\n\n2 passed', truncated: false, error: null },
      { line: 'npm run lint', argv: ['npm', 'run', 'lint'], exit: 0, ms: 3200, output: '检查了 18 个文件，没有发现问题。', truncated: false, error: null },
    ],
  },
  t21: {
    v: 1, attempt: 1, ms: 9100, ok: false, base: 'a1b2c3d', head: '2e91b40',
    commit: { required: true, ok: true }, uncommitted: [],
    scope: { allowed: ['src/export/**', 'tests/export-*'], changed: ['src/export/filter.ts', 'tests/export-filter.test.ts', 'src/legacy/report.ts'], outside: ['src/legacy/report.ts'] },
    commands: [
      { line: 'npm test -- export', argv: ['npm', 'test', '--', 'export'], exit: 0, ms: 6100, output: '✓ 按标签筛选导出\n✓ 空结果\n\n2 passed', truncated: false, error: null },
      { line: 'node tools/check-scope.mjs', argv: ['node', 'tools/check-scope.mjs'], exit: 1, ms: 2400, output: '读取允许范围：src/export/**、tests/export-*\n检查改动文件……\n发现越界文件：src/legacy/report.ts\n……（更早的输出省略）', truncated: true, error: null },
    ],
  },
};
// summary 不手写：用核心的 summarizeGate 按协议 12.3 生成，演示数据与真实门禁同一种写法。
for (const gate of Object.values(gates)) gate.summary = summarizeGate(gate);
const GROUPS = { run: '进行中', today: '今天', yesterday: '昨天' };
const GROUP_DATE = { today: '10-08', yesterday: '10-07' };

const plan1 = [['读任务说明和现有背包实现', 'done'], ['拖拽状态机：按下、拖动、放下、取消', 'done'], ['堆叠合并与上限 99', 'now'], ['截图验收脚本：拖拽前后各一张', ''], ['验证、提交、汇报', '']];
const ev1 = [
  ['15:21', 'say', '先读 <code>AGENTS.md</code>、工程角色文档和任务说明，再看现有的背包实现。'],
  ['15:21', 'cmd', 'rg -n "Inventory" src', 0, 'src/inventory/Inventory.ts:12:export class Inventory {\nsrc/inventory/Inventory.ts:48:  add(item: Item, count = 1) {\nsrc/ui/InventoryPanel.ts:5:import { Inventory } from "../inventory/Inventory";'],
  ['15:23', 'think', '拖拽要和点击区分开：按下后移动超过 4px 才进入拖动，否则当作点击选中。'],
  ['15:25', 'file', [['add', 'src/inventory/drag.ts'], ['update', 'src/inventory/Inventory.ts'], ['update', 'src/ui/InventoryPanel.ts']]],
  ['15:31', 'cmd', 'npm test -- inventory', 1, '✓ 拖动超过 4px 才开始拖拽\n✓ 放到空格子\n✕ 同类物品合并后不超过 99\n  expected 99, received 100\n\n1 failed, 11 passed'],
  ['15:32', 'say', '堆叠上限的测试没过：合并时没有截断到 99。修正 <code>mergeStacks</code> 后再跑一遍。'],
  ['15:34', 'file', [['update', 'src/inventory/stack.ts']]],
  ['15:35', 'turn', '一轮结束 · 输入 182K · 输出 6.4K'],
  ['15:39', 'cmd', 'npm test -- inventory', null, ''],
];
const ev5 = [
  ['11:47', 'say', '先读任务说明。导出 PDF 需要无头浏览器，检查项目里是否已有依赖。'],
  ['11:48', 'cmd', 'npm ls puppeteer', 1, 'notes-web@0.4.0\n└── (empty)'],
  // 任务 011：时间线「说话」用 Markdown 排版（粗体、嵌套列表、表格）。放在 t5 是为了不加长 t1 的时间线——
  // t1 的"滚到底部时保持跟随"检查按原有内容高度写，t1 的演示事件一条都不能多。
  ['11:49', 'say', '**改动方案**：\n\n- 导出 PDF 的两条路\n  - 复用已有的打印预览\n  - 新增无头浏览器依赖\n- 依赖要先在汇报里说明理由\n\n| 步骤 | 状态 |\n|:---|:---:|\n| 查依赖 | 完成 |\n| 定方案 | 进行中 |'],
  ['11:56', 'turn', '一轮结束 · 输入 64K · 输出 2.1K'],
  ['11:57', 'err', '连接中断：stream disconnected before completion（重试 5 次后放弃）'],
];
const ev6 = [
  ['10:05', 'say', '先读任务说明和现有的粒子系统。'],
  ['10:06', 'cmd', 'rg -n "new Particle" src', 0, 'src/fx/Emitter.ts:31:    this.items.push(new Particle(x, y));'],
  ['10:08', 'file', [['add', 'src/fx/pool.ts']]],
];
const files3 = [['update', 'src/save/schema.ts'], ['add', 'src/save/migrations/v2.ts'], ['add', 'src/save/migrations/v3.ts'], ['update', 'src/save/load.ts'], ['add', 'tests/save-migration.test.ts'], ['add', 'tests/fixtures/save-v1.json'], ['update', 'docs/save-format.md']];

// 演示汇报正文（t3「011-存档版本迁移」的 report.md）：覆盖表格（含对齐与宽表格）、粗体、引用、
// 分隔线、嵌套列表、任务列表与带语言的代码块；TODO(lead) / 推断清单两个高亮段落保持相邻。
// tools/demo/index.mjs 的汇报文本不归任务 011 所有，这里由 run.mjs 与截图验收写入同一份内容。
const reportRich = [
  '# 完成了什么',
  '',
  '**存档版本迁移**已完成：读取时按 v1 → v2 → v3 逐级迁移；旧存档读取后自动写回新格式，并保留一份 `.bak`。',
  '',
  '提交：`4f2a9c1`',
  '',
  '## 验证',
  '',
  '| 命令 | 结果 | 备注 |',
  '|:---|:---:|---:|',
  '| `npm test` | 46/46 | 新增迁移测试 9 条 |',
  '| 样例读取 | 通过 | 3 份旧存档都对得上 |',
  '',
  '- `npm test` 46/46 通过，新增迁移测试 9 条。',
  '  - 背包、地图、设置都对得上',
  '  - 失败时回滚到 `.bak`',
  '- [x] 用 3 份旧存档样例实际读取',
  '- [ ] 迁移提示文案定稿',
  '',
  '> 迁移失败时保留原文件，**不覆盖**玩家存档。',
  '',
  '---',
  '',
  '```ts',
  'save.load().migrate(v1);',
  '```',
  '',
  '## 宽表格样例',
  '',
  '### 迁移步骤',
  '',
  '#### 样例文件路径很长时只在表格里横向滚动',
  '',
  '| 步骤 | 命令 | 期望结果 | 实际结果 | 样例文件 |',
  '|:---|:---|:---|:---|:---|',
  '| v1 → v2 | `npm run migrate -- --from v1` | 背包与地图字段全部迁到 v2 结构 | 通过 | tests/fixtures/save-v1.json |',
  '| v2 → v3 | `npm run migrate -- --from v2` | 设置字段迁到 v3 且未知字段保留 | 通过 | inventory_backpack_stack_migration_with_unknown_field_preservation_and_a_very_long_file_name.json |',
  '',
  '## TODO(lead) 2 条',
  '',
  '1. 迁移失败时给玩家看的提示文案，现在是占位“【文案待定：存档无法升级】”。',
  '2. 是否在读取旧存档时提示“已升级”。',
  '',
  '## 推断清单 3 条',
  '',
  '1. 备份文件名用 `<存档名>.bak`，只保留最近一份。',
  '2. 未知字段原样保留，不删除。',
  '3. 版本号写在存档顶层 `v` 字段。',
  '',
  '## 已知问题',
  '',
  '无。',
].join('\n');

export { tasks, gates, plan1, ev1, ev5, ev6, files3, reportRich };
