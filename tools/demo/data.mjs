import { summarizeGate } from '../../core/lib/gate.mjs';

// 多次尝试演示任务的第一个执行者（DeepSeek）；第 3 次升级用的 claude-native 见 attemptSets。
const DS = { profile: 'deepseek', adapter: 'claude-code', label: 'DeepSeek V4 Pro', model: 'deepseek-v4-pro', agentVersion: '2.1.302 (Claude Code)' };
// 087 worktree 演示任务的另外两个执行者（界面稿的 MM / CL）。
const MM = { profile: 'mimo', adapter: 'claude-code', label: 'MiMo V2.6 Flash', model: 'mimo-v2.6-flash', agentVersion: '2.1.304 (Claude Code)' };
const CL = { profile: 'claude-native', adapter: 'claude-code', label: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', agentVersion: '2.1.302 (Claude Code)' };
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
  // 056：t24 门禁未通过，演示受保护路径越界与删除的文件（gate.json 带 protected / deleted）；
  // t21 保留旧式 gate.json（没有这两个字段），用来检查旧记录不显示"删除的文件"一块。
  { id: 't20', day: 'today', name: '020-导出书签', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'done', start: '09:20', dur: '7.4 分钟', commit: '7f0c9de', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't21', day: 'today', name: '021-导出筛选', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'fail', exit: 3, agentExit: 0, start: '09:05', dur: '6.1 分钟', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't22', day: 'today', name: '022-整理导出文档', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'done', start: '08:50', dur: '3.5 分钟', commit: '5b7e2c0', sandbox: 'workspace-write', gate: false, base: 'a1b2c3d' },
  { id: 't24', day: 'today', name: '024-调整导出权限', project: 'reader-app', host: 'Claude Code', role: '执行者', state: 'fail', exit: 3, agentExit: 0, start: '08:35', dur: '5.2 分钟', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  // Stage05 多次尝试演示（061，UI23；默认隐藏，形状照界面稿的 ATTEMPTS，尝试明细在下面的 attemptSets）：
  // t25 自动重试进行中（第 2/3 次，门禁等待）。运行中的任务不会被"隐藏"，所以演示里它没有存活的派发进程（状态是中断）；
  // UI23 检查时临时拉起一个假派发进程并追加 resume，让它回到进行中，检查完恢复。
  // t26 升级后第 3 次完成（第 3 次换用 claude-native）。
  { id: 't25', day: 'today', name: '025-导出 JSON', project: 'reader-app', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: DS, state: 'retrying', start: '15:40', dur: '6:12', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't26', day: 'today', name: '026-快捷键设置', project: 'reader-app', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: DS, state: 'done', start: '12:20', dur: '32.4 分钟', commit: '7c1d2e9', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  // t27（Stage06 评分，UI26）：形状照界面稿评分场景——三次尝试、第 3 次升级换用 claude-native、第 2 次动了受保护的任务说明；默认隐藏，评分由真实核心对这些数据计算。
  { id: 't27', day: 'today', name: '027-快捷键冲突提示', project: 'reader-app', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: DS, state: 'done', start: '11:10', dur: '31.5 分钟', commit: '3e4f5a6', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  // Stage06 worktree 任务演示（087，UI24 / UI25；默认隐藏，形状照界面稿的 t20～t25）：排队、准备、待验收、合并冲突、已合并、已驳回。
  // state 写 'wt'：不走上面四态的 end / interrupted 生成，事件序列由 index.mjs 按 wt.phase 生成（见 wtEvents）。
  // 排队与准备中的任务演示里没有存活的派发进程（运行中的任务不会被隐藏，默认显示会变成"已中断"）；
  // 设 AR_DEMO_SHOW_WORKTREE=1 时演示额外拉起两个假派发进程，npm run demo 里就能看到它们真的在排队 / 准备。
  { id: 't30', day: 'today', state: 'wt', wt: { phase: 'queued', branch: 'ar/9c1e07b2a4' }, name: '018-导出 Markdown', project: 'notes-web', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: MM, start: '15:44', dur: '1:12', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't31', day: 'today', state: 'wt', wt: { phase: 'preparing', branch: 'ar/3b7d5f19e0' }, name: '019-夜间模式', project: 'pixel-garden', host: 'Claude Code', role: '执行者', executor: DS, start: '15:46', dur: '0:38', last: '准备：npm ci', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't32', day: 'today', state: 'wt', wt: { phase: 'awaiting', branch: 'ar/5f3a9c1e2d', head: 'c2d4e61' }, name: '020-成就弹窗', project: 'pixel-garden', host: 'Claude Code', role: '执行者', executor: DS, start: '14:31', dur: '18.6 分钟', commit: 'c2d4e61', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d', goal: '解锁成就时弹出提示，自动收起；同时解锁多个时排队显示。' },
  { id: 't33', day: 'today', state: 'wt', wt: { phase: 'conflict', branch: 'ar/7e2c4d8b91', head: '8a1f2b3', files: ['src/save/schema.ts', 'tests/save-migration.test.ts'] }, name: '021-存档导出 JSON', project: 'pixel-garden', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: CL, start: '13:58', dur: '24.1 分钟', commit: '8a1f2b3', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d', goal: '把存档导出为 JSON 文件，字段与存档版本 v3 一致；导出前先迁移旧存档。' },
  { id: 't34', day: 'today', state: 'wt', wt: { phase: 'accepted', branch: 'ar/2c6b1d4a77', head: '5e8a0c3', merge: '9b3f0a2', by: 'lead' }, name: '013-音量滑块', project: 'pixel-garden', host: 'Claude Code', role: '执行者', executor: DS, start: '13:20', dur: '11.3 分钟', commit: '5e8a0c3', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
  { id: 't35', day: 'today', state: 'wt', wt: { phase: 'rejected', branch: 'ar/8d1e5c2f03', head: '4b2c7d9', by: 'human', reason: '方向不对：主题跟随系统即可，不要加手动开关' }, name: '017-换肤主题', project: 'notes-web', host: 'AgentRouter（软件）', dispatcher: 'agentrouter', role: '执行者', executor: MM, start: '12:48', dur: '14.0 分钟', commit: '4b2c7d9', sandbox: 'workspace-write', gate: true, base: 'a1b2c3d' },
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
  // 056：受保护路径（任务说明目录、项目配置）越界 + 删除的文件——两个新字段 protected / deleted 的演示；
  // 删除的旧测试在允许范围内，只提示、不让门禁因此失败（失败来自两条越界）。
  t24: {
    v: 1, attempt: 1, ms: 5400, ok: false, base: 'a1b2c3d', head: '3c4d5e6',
    commit: { required: true, ok: true }, uncommitted: [],
    scope: {
      allowed: ['src/**', 'tests/**'],
      changed: ['src/export/permissions.ts', 'tests/export/permission.test.ts', 'docs/specs/024-调整导出权限.md', '.agent-router/project.json', 'tests/export/legacy-permission.test.ts'],
      outside: ['docs/specs/024-调整导出权限.md', '.agent-router/project.json'],
      protected: ['docs/specs/024-调整导出权限.md', '.agent-router/project.json'],
      deleted: ['tests/export/legacy-permission.test.ts'],
    },
    commands: [
      { line: 'npm test -- export', argv: ['npm', 'test', '--', 'export'], exit: 0, ms: 4200, output: '✓ 导出权限检查\n✓ 无权限时拒绝\n\n2 passed', truncated: false, error: null },
    ],
  },
};
// 087：worktree 演示任务（t32～t35）门禁都通过；写法同 t20。
const wtGate = (head, changed) => ({
  v: 1, attempt: 1, ms: 12300, ok: true, base: 'a1b2c3d', head, commit: { required: true, ok: true }, uncommitted: [],
  scope: { allowed: ['src/**', 'tests/**'], changed, outside: [], protected: [], deleted: [] },
  commands: [
    { line: 'npm test', argv: ['npm', 'test'], exit: 0, ms: 9210, output: 'ℹ tests 51\nℹ pass 51\nℹ fail 0', truncated: false, error: null },
    { line: 'npm run lint', argv: ['npm', 'run', 'lint'], exit: 0, ms: 2840, output: '', truncated: false, error: null },
  ],
});
gates.t32 = wtGate('c2d4e61', ['src/achievements/popup.ts', 'src/achievements/store.ts', 'src/ui/Toast.ts', 'tests/achievements.test.ts']);
gates.t33 = wtGate('8a1f2b3', ['src/save/export.ts', 'src/save/schema.ts', 'tests/save-migration.test.ts']);
gates.t34 = wtGate('5e8a0c3', ['src/audio/volume.ts', 'tests/audio-volume.test.ts']);
gates.t35 = wtGate('4b2c7d9', ['src/theme/skin.ts', 'tests/theme-skin.test.ts']);
// summary 不手写：用核心的 summarizeGate 按协议 12.3 生成，演示数据与真实门禁同一种写法。
for (const gate of Object.values(gates)) gate.summary = summarizeGate(gate);

// ---------- Stage05 多次尝试演示数据（061，协议第 14 节；形状照界面稿 preview.js 的 ATTEMPTS）----------
// 每次尝试：offset 是相对任务开始的毫秒，ms 是这次用时（没有 ms = 还在进行）；gateOk 是 attempt-end 的 gate 字段；
// gate 是这次的 gate.json（attempts/<n>/gate.json，summary 由核心的 summarizeGate 生成）；report 是这次的汇报；events 是这次的进展。
const attemptGate = (n, ms, { ok, head, changed, outside = [], protectedPaths = [], commands }) => {
  const gate = { v: 1, attempt: n, ms, ok, base: 'a1b2c3d', head, commit: { required: true, ok: true }, uncommitted: [],
    scope: { allowed: ['src/**', 'tests/**'], changed, outside, protected: protectedPaths, deleted: [] }, commands };
  gate.summary = summarizeGate(gate);
  return gate;
};
const cmd = (line, exit, ms, output) => ({ line, argv: line.split(' '), exit, ms, output, truncated: false, error: null });
const attemptSets = {
  t25: [
    { n: 1, total: 3, profile: 'deepseek', reason: 'first', offset: 0, ms: 426000, exit: 0, gateOk: false, usage: { input: 38400, output: 5200 },
      gate: attemptGate(1, 8100, { ok: false, head: '2c8e017', changed: ['src/export/json.ts', 'tests/export/json.test.ts'], commands: [cmd('npm test -- tests/export', 1, 8100, 'ℹ tests 18\nℹ pass 17\nℹ fail 1')] }),
      report: '# 完成了什么（第 1 次尝试）\n\n实现了 JSON 导出；日期字段的输出还有 1 条测试没过。\n',
      events: [['say', '先读任务说明和现有的导出模块。'], ['file', [['add', 'src/export/json.ts']]], ['cmd', 'npm test -- tests/export', 1, 'ℹ tests 18\nℹ pass 17\nℹ fail 1'], ['say', '已提交，汇报写好了。']] },
    { n: 2, total: 3, profile: 'deepseek', reason: 'gate', offset: 450000,
      events: [['say', '上一次 tests/export 有 1 条没过：日期没有按 ISO 格式输出。先修这个。'], ['cmd', 'npm test -- tests/export', null]] },
  ],
  t26: [
    { n: 1, total: 3, profile: 'deepseek', reason: 'first', offset: 0, ms: 564000, exit: 0, gateOk: false, usage: { input: 41200, output: 6800 },
      gate: attemptGate(1, 7600, { ok: false, head: '1a2b3c4', changed: ['src/input/keymap.ts'], commands: [cmd('npm test', 1, 7600, 'ℹ tests 22\nℹ pass 20\nℹ fail 2')] }),
      report: '# 完成了什么（第 1 次尝试）\n\n实现了快捷键设置页；有 2 条测试没过，我认为是测试本身的问题。\n',
      events: [['say', '先读任务说明和现有的输入模块。'], ['file', [['add', 'src/input/keymap.ts']]], ['cmd', 'npm test', 1, 'ℹ tests 22\nℹ pass 20\nℹ fail 2'], ['say', '已提交，汇报写好了。']] },
    { n: 2, total: 3, profile: 'deepseek', reason: 'gate', offset: 600000, ms: 522000, exit: 0, gateOk: false, usage: { input: 29500, output: 4100 },
      gate: attemptGate(2, 6200, { ok: false, head: '5d6e7f8', changed: ['src/input/keymap.ts', 'docs/specs/026-快捷键设置.md'], outside: ['docs/specs/026-快捷键设置.md'], protectedPaths: ['docs/specs/026-快捷键设置.md'], commands: [cmd('npm test', 0, 6200, 'ℹ tests 22\nℹ pass 22\nℹ fail 0')] }),
      report: '# 完成了什么（第 2 次尝试）\n\n修好了失败的测试，并把任务说明里的验收命令改短了（门禁判为越界）。\n',
      events: [['say', '修好了测试；顺手把任务说明里的验收命令改短了。'], ['file', [['update', 'docs/specs/026-快捷键设置.md']]], ['say', '已提交，汇报写好了。']] },
    { n: 3, total: 3, profile: 'claude-native', reason: 'gate', offset: 1140000, ms: 804000, exit: 0, gateOk: true, usage: { input: 52000, output: 9300 },
      gate: attemptGate(3, 8400, { ok: true, head: '7c1d2e9', changed: ['src/input/keymap.ts', 'tests/input/keymap.test.ts'], commands: [cmd('npm test', 0, 8400, 'ℹ tests 26\nℹ pass 26\nℹ fail 0')] }),
      report: '# 完成了什么（第 3 次尝试）\n\n恢复了上一次改动的任务说明；在 keymap 里处理冲突的快捷键，新增 4 条测试，全部通过。\n',
      events: [['say', '恢复了任务说明；改为在 keymap 里处理冲突的快捷键。'], ['cmd', 'npm test', 0, 'ℹ tests 26\nℹ pass 26\nℹ fail 0'], ['say', '验收命令全部通过，已提交。']] },
  ],
  // t27：评分演示。第 1 次门禁因测试失败，第 2 次因动了受保护的任务说明，第 3 次升级换用 claude-native 通过；
  // 事件里有 2 条出错和 1 条失败的命令，评分里"工具报错"是 3 个。
  t27: [
    { n: 1, total: 3, profile: 'deepseek', reason: 'first', offset: 0, ms: 540000, exit: 0, gateOk: false, usage: { input: 44800, output: 7100 },
      gate: attemptGate(1, 7200, { ok: false, head: '4a5b6c7', changed: ['src/input/conflict.ts'], commands: [cmd('npm test', 1, 7200, 'ℹ tests 20\nℹ pass 18\nℹ fail 2')] }),
      report: '# 完成了什么（第 1 次尝试）\n\n实现了快捷键冲突提示；有 2 条测试没过。\n',
      events: [['say', '先读任务说明和现有的快捷键模块。'], ['file', [['add', 'src/input/conflict.ts']]], ['cmd', 'npm test', 1, 'ℹ tests 20\nℹ pass 18\nℹ fail 2'], ['error', '读取 tests/input/conflict.test.ts 失败：文件不存在'], ['say', '已提交，汇报写好了。']] },
    { n: 2, total: 3, profile: 'deepseek', reason: 'gate', offset: 580000, ms: 480000, exit: 0, gateOk: false, usage: { input: 31200, output: 4600 },
      gate: attemptGate(2, 6400, { ok: false, head: '8d9e0f1', changed: ['src/input/conflict.ts', 'docs/specs/027-快捷键冲突提示.md'], outside: ['docs/specs/027-快捷键冲突提示.md'], protectedPaths: ['docs/specs/027-快捷键冲突提示.md'], commands: [cmd('npm test', 0, 6400, 'ℹ tests 20\nℹ pass 20\nℹ fail 0')] }),
      report: '# 完成了什么（第 2 次尝试）\n\n修好了失败的测试，并把任务说明里的验收命令改短了（门禁判为越界）。\n',
      events: [['say', '修好了测试；顺手把任务说明里的验收命令改短了。'], ['file', [['update', 'docs/specs/027-快捷键冲突提示.md']]], ['error', '运行 npm run lint 时被中断'], ['say', '已提交，汇报写好了。']] },
    { n: 3, total: 3, profile: 'claude-native', reason: 'gate', offset: 1100000, ms: 780000, exit: 0, gateOk: true, usage: { input: 46700, output: 8500 },
      gate: attemptGate(3, 8100, { ok: true, head: '3e4f5a6', changed: ['src/input/conflict.ts', 'tests/input/conflict.test.ts'], commands: [cmd('npm test', 0, 8100, 'ℹ tests 24\nℹ pass 24\nℹ fail 0')] }),
      report: '# 完成了什么（第 3 次尝试）\n\n恢复了上一次改动的任务说明；冲突的快捷键在设置页里标红并给出提示，新增 4 条测试，全部通过。\n',
      events: [['say', '恢复了任务说明；改为在设置页里标出冲突的快捷键。'], ['cmd', 'npm test', 0, 'ℹ tests 24\nℹ pass 24\nℹ fail 0'], ['say', '验收命令全部通过，已提交。']] },
  ],
};
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

// 087：worktree 演示任务的派发参数里的门禁设置（dispatch.json 的 gate.merged）：允许改动与验收命令。
// 放在这里而不是生成器里：生成器的字符串字面量会被"演示文本里没有字面的 **"那条测试逐条扫描，允许路径的通配符不是文本。
const wtMerged = { allowed_paths: ['src/**', 'tests/**'], verify: ['npm test', 'npm run lint'] };

// 087：t32（待验收）的汇报，含 TODO(lead) 与推断清单两个高亮段落。
const wtReport = [
  '# 完成了什么', '',
  '解锁成就时弹出提示，3 秒后自动收起；同时解锁多个时排队依次显示。`unlock` 现在返回是否新解锁，并发出 `unlocked` 事件。', '',
  '提交：`c2d4e61`', '',
  '## 验证', '',
  '`npm test` 51/51 通过，新增 6 条成就弹窗测试；`npm run lint` 通过。', '',
  '## TODO(lead) 1 条', '',
  '1. 弹窗文案"解锁成就：<名称>"是占位，等你定。', '',
  '## 推断清单 2 条', '',
  '1. 弹窗显示 3 秒；任务说明没写时长。',
  '2. 多个成就同时解锁时按解锁顺序排队，不合并成一条。',
].join('\n');

export { tasks, gates, attemptSets, plan1, ev1, ev5, ev6, files3, reportRich, wtReport, wtMerged };
