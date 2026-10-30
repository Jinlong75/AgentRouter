// 文案来自任务 003 与定稿；后续由主导维护。
// Stage03：执行者不再统称"Codex"（O8），需要名字的地方用执行者显示名（派发时的 label）。
export const c = {
    app: 'AgentRouter', tasks: '任务', connect: 'Agent', settings: '设置', about: '关于', protocol: '文件协议 v2',
    newTask: '新建任务', projectsNav: '项目', configGroup: '配置',
    status: { run: '进行中', done: '已完成', fail: '失败', stop: '已中断' },
    all: '全部', issues: '失败或中断', projects: '全部项目', import: '导入旧任务', today: '今天', yesterday: '昨天',
    running: (n: number) => n ? `${n} 个任务进行中` : '没有进行中的任务',
    // 侧栏状态行：按执行者统计正在运行的任务（Stage06 起加并发上限，写成 1/2）
    load: (parts: [label: string, n: number][]) => parts.map(([label, n]) => `${label} ${n}`).join(' · '), loadHelp: '正在运行的任务数（按执行者）',
    empty: '还没有派发过任务', emptyHelp: '点"新建任务"选项目和执行者派发；在 Claude Code 里让主导派活，任务也会出现在这里。',
    select: '选择一个任务', emptyDetail: '这里会显示任务的进展和汇报', detailHelp: '进展、汇报、改动的文件和派发参数都在这里看。',
    stop: '停止', more: '更多', cancel: '取消', stopTitle: (name: string) => `停止「${name}」？`, stopBody: (executor: string) => `${executor} 会立刻结束，工作区里没提交的改动会保留。`, changed: '任务状态已经变了，请重试',
    flow: '进展', report: '汇报', files: '改动', params: '参数', think: '显示思考', plan: '计划', follow: '正在跟随最新进展', latest: '跳到最新',
    closed: '派发会话已关闭', readonly: '只读任务', started: '开始', minutes: '分钟', elapsed: '用时', commit: '提交', runningCmd: '运行中…',
    failedTitle: (executor: string, exit: number | null | undefined) => `${executor} 异常退出（exit=${exit}）`, failedHelp: '原因见最后一条。要重试，点"再派一次"，或在派活方的会话里重新派发；工作区里没提交的改动会保留。',
    interruptedTitle: '派发会话关闭，任务被一起中断', interruptedHelp: '任务是派发会话的子进程。在设置里打开"托管"后，关掉会话也不会中断任务；从本软件派发的任务不受影响。',
    reportLater: '任务结束后显示汇报', noReport: '没有汇报', noReportHelp: (executor: string) => `任务没有正常结束，${executor} 没来得及写汇报。看"进展"了解停在哪里。`,
    // exit=0 但没有汇报文件：任务正常结束了，只是没写汇报（O8：不再说"没有正常结束"）
    noReportDone: (executor: string) => `${executor} 正常结束，但没有写汇报。看"进展"里最后几条说话。`,
    noFiles: '没有改动文件', filesHelp: '按执行者报告的改动汇总', filesLive: '，任务进行中会继续增加', kinds: { add: '新增', update: '修改', delete: '删除' },
    // 进程查询失败（W4）：保留最后已知状态，不推断任务已结束；依赖进程状态的操作暂停
    processUnknownTitle: '暂时无法确认任务进程是否还在运行', processUnknownTag: '状态未知', processUnknownBlocked: '暂时无法确认进程状态，稍后再试',
    processUnknownHelp: (failures: number, error: string) => `正在自动重试（已连续失败 ${failures} 次）。确认之前，进行中的任务保持原状态；停止、从列表隐藏和删除暂不可用。原因：${error}`,
    open: '打开', openRepo: '打开仓库文件夹', openSpec: '打开任务说明', openReport: '打开汇报文件', reportPending: '打开汇报文件（汇报尚未生成）', openProgress: '打开进度文件', copyName: '复制记录名', hide: '从列表隐藏',
    // 同一份任务说明派发了不止一次（"再派一次"或重复派发），记录名带 -N 时在标题后显示
    attempt: (n: number) => `第 ${n} 次`, attemptTip: (name: string) => `记录名：${name}`,
    // 批量删除任务（017）：列表进入选择模式，勾选已结束的任务后删除
    multiSelect: '选择', multiDone: '完成', multiCount: (n: number) => `已选 ${n} 个`, multiAll: '全选已结束的', multiNone: '取消全选',
    multiRunning: '进行中的任务不能删除', multiDelete: '删除…',
    // Stage07b T4m：选择模式下把已结束任务的任务说明 git mv 到 docs/specs/archive/ 并提交（不删除任何文件；取新编号时归档里的也算）
    multiArchive: '归档任务说明…', archiveTitle: (n: number) => `归档 ${n} 份任务说明？`,
    archiveBody: (dir: string) => `移到 ${dir}/archive/ 并提交。新建任务说明时归档里的编号也算在内，编号继续递增；新建任务页的列表默认不显示归档，可以展开。`,
    archiveNote: (n: number) => `git mv 这 ${n} 个文件，并提交`, archiveConfirm: '归档并提交', archived: (n: number, hash: string) => `已归档 ${n} 份任务说明（提交 ${hash}）`,
    archiveNone: '选中的任务没有可以归档的任务说明（直接文字派发的任务、或说明已经归档）', archiveSkipped: (n: number) => `${n} 个任务没有可归档的说明，已跳过`,
    deleteTitle: (n: number) => `删除 ${n} 个任务？`, deleteBody: '从任务列表里移除。项目里的代码和提交不受影响。',
    deleteFiles: '同时删除项目里的任务记录文件', deleteFilesHelp: '删除这些任务在各项目 .agent-runs 里的记录目录（进度、汇报、原始输出），删除后无法恢复。旧版本导入的任务没有这类目录，会跳过。',
    deleteConfirm: '删除', deleted: (n: number) => `已删除 ${n} 个任务`, deleteLeft: (n: number) => `${n} 个记录目录没能删除（可能正被占用），任务已从列表移除`,
    // Stage07b T4o：任务详情 ⋯ 菜单里删除这一个任务（确认框与批量删除同一个，说明与勾选项相同）
    deleteOne: '删除任务…', deleteOneTitle: (name: string) => `删除任务「${name}」？`, deletedOne: (name: string) => `已删除「${name}」`,
    // Stage07b T4d④：门禁失败或已中断的 worktree 任务，在原 worktree 合并主分支后用新基线重跑门禁（ar retry --rebase，不启动执行者）
    rebaseRun: '合并主分支后重跑', rebaseRunTip: (base: string) => `在原 worktree 里合并 ${base} 的新提交，再用新基线重跑门禁；不启动执行者`, rebaseRunning: '正在开始…',
    // Stage07 116：任务的项目已从项目列表移除（第二轮走查发现：待验收任务卡死）
    projectGoneTitle: '这个任务的项目已从项目列表移除', projectGoneHelp: (path: string) => `项目 ${path} 不在项目列表里。驳回、确认和从列表删除照常可以做；要合并或重试，先把项目重新添加回来。`,
    projectGoneReAdd: '重新添加项目', projectGoneMissing: (path: string) => `项目文件夹 ${path} 已经不存在：只能从列表删除这个任务。它留下的 worktree 可以在设置 → 数据 → 清理里清掉。`,
    projectGoneBlocked: '项目已从项目列表移除，先重新添加项目',
    record: '记录名', route: '路由', effortDefault: '默认（不传参数）', spec: '任务说明', direct: '直接给的任务文字', role: '角色', noRole: '不指定', dispatcher: '派活方', agent: '干活方', executor: '执行者', model: '模型', effort: '推理强度', tier: '档位', sandbox: '沙箱', repo: '仓库', records: '记录文件', progress: '进度', events: '统一事件', raw: '原始输出', followCodex: '跟随 Codex', turn: '一轮结束', input: '输入', output: '输出',
    // Stage07c D81（151）：参数标签里每个值后面写来源；键是核心 settingSources 的取值（命令行、环境变量 X 都算单次派发）
    sourceLabels: { cli: '单次派发', spec: '任务说明', rule: '路由规则', profile: '执行者配置', builtin: '程序自己的设置', escalate: '升级链', ignored: '不支持推理强度，已忽略' } as Record<string, string>,
    fromSource: (label: string) => `（来自${label}）`,
    // Stage07c D86（151）：和待验收的任务改动范围重叠（核心 overlap-note 事件）
    overlapAwaiting: (name: string) => `与待验收的「${name}」改动范围重叠，「${name}」合并后可能冲突`,
    rebaseAfterMerge: (name: string) => `「${name}」已合并，与它的改动范围重叠：正在按新基线重跑门禁`,
    error: '操作没有完成，请重试', reportMissing: '汇报尚未生成或文件已不存在', fileMissing: '文件已不存在', earlier: '加载更早的进展', unknownHost: '其他派活方', appHost: 'AgentRouter（软件）',
    // 用户在本软件里停止的任务（signal 为 stopped-by-app）
    stopped: '你停止了这个任务', stoppedHelp: '工作区里没提交的改动还在。要继续，点"再派一次"，或在派活方的会话里重新派发。', stoppedShort: '手动停止',
    // 派活方用 --stop 停止的任务（signal 为 stopped-by-command），说明文字沿用 stoppedHelp
    stoppedByCommand: '派活方停止了这个任务', stoppedByCommandShort: '派活方停止',
    managed: '托管', yes: '是', no: '否', goSettings: '去设置', managedOn: '托管已开启', managedOff: '托管未开启',
    imported: '导入的旧任务', legacy: '旧任务', planNow: '当前',
    // 再派一次（O4）：同样的任务说明、执行者和参数，新的记录名
    redispatch: '再派一次', redispatchHelp: '用同样的任务说明、执行者和参数重新派发', redispatching: '正在派发…', redispatchRunning: '任务还在运行，结束后才能再派一次', redispatchFailed: '没有再派出去',
};

// 以下逐项取自 004 任务说明与界面定稿。
export const p = {
    subtitle: '谁在派活、谁在干活', detect: '重新检测', detected: '已检测到', missingHost: '未检测到',
    dispatchers: '主导', workers: '执行者', dispatchHelp: '在这些工具里装上技能，它们就能写任务说明、把工作派给执行者。装之前会备份原来的版本，可以回退。', workerHelp: '实际执行任务的 Agent。任务按路由页的规则分配给它们；没有规则命中时派给"默认"那一个。',
    hostMissing: (host: string) => `没有找到 ${host}。装好以后点右上角"重新检测"。`,
    latest: '最新', update: (version: string) => `可更新到 ${version}`, missing: '未安装', custom: '自己改过的版本', protected: '不会自动替换',
    actions: { install: '安装', update: '更新', reinstall: '重新安装', rollback: '回退', replace: '备份后替换…' } as Record<string, string>,
    replace: '替换', rollbackTitle: (host: string) => `回退「${host}」的技能？`, rollbackBody: '回到上一次操作之前的状态。当前版本会先备份，之后还能再回退。',
    replaceTitle: (skill: string) => `替换「${skill}」？`, replaceBody: '这份不是 AgentRouter 装的，或者装好后被改过。替换前会先备份，随时可以回退。',
    customHelp: '这份 agent-router 不是 AgentRouter 装的，或者装好后被改过。更新时默认跳过它；要换成公开版，先备份再替换，随时可以回退。',
    dependency: 'lead-workflow 需要 agent-router',
    legacySkills: (names: string) => `检测到旧版 DispatchDock 技能：${names}。AgentRouter 不再使用它们。`,
    removeLegacy: '删除旧版技能', removeLegacyTitle: '删除旧版 DispatchDock 技能？', removeLegacyBody: (names: string) => `删除 ${names}。删除前会先备份，之后可以用“回退”恢复。`, legacyRemoved: '已删除旧版技能 · 可以回退', backupHint: '替换前会备份', updateHint: '更新前会备份，可以回退',
    installed: (n: number) => `已安装 ${n} 个 · 可以回退`, rolledBack: '已回退',
    lastInstall: (time: string) => `上次安装 ${time}`,
    runnable: '可以运行', notFound: '找不到', codexMissing: '找不到 Codex CLI', codexHelp: '确认在终端里能运行 codex --version。用 pnpm、scoop 这类方式装的，可以手动指定 Codex 的位置。',
    version: '版本', location: '位置', login: '登录', auto: '自动查找', choose: '指定位置…', reset: '改回自动查找',
    loginStates: { in: '已登录', out: '未登录', unknown: '无法确定' } as Record<string, string>,
    versionChange: (old: string, next: string) => `Codex 从 ${old} 升级到了 ${next}。如果任务进展里出现大量没整理过的原始文本，可能是它的输出格式变了。`, ack: '知道了',
    follow: (value?: string) => `跟随 Codex（${value || '未设置'}）`, customModel: '自定义…', currentHelp: '括号里是 Codex 现在的配置',
    tier: '服务档位', sandboxHelp: '派出的工作要写文件、提交，所以默认可写工作区', writable: '可写工作区', readonly: '只读',
    override: (name: string, value: string) => `环境变量 ${name} 正在覆盖这一项（${value}）`,
    watch: '进度窗口', watchTitle: '弹出只读进度窗口', watchHelp: '"自动"：本软件开着时不弹，在这里看；没开时弹出终端窗口', watchOptions: ['自动', '总是', '从不'],
    notifications: '通知', notify: '任务结束时通知', notifyHelp: '完成、失败、中断都会通知；点通知直接打开这个任务',
    appearance: '外观', theme: '主题', themes: ['跟随系统', '浅色', '深色'], config: '配置文件', openFolder: '打开所在文件夹',
    configError: (reason: string) => `config.json 无法读取（${reason}）。修好或删掉它之后，这里才能修改派发默认值。`,
    welcome: '欢迎使用 AgentRouter', welcomeHelp: '强的 Agent 当主导写任务说明，便宜或专长的 Agent 当执行者干活，你在这里统一派发、查看、停止和验收。先看看这台电脑上有什么。',
    installSkills: '安装技能', installHelp: '技能装在主导（Claude Code）里，告诉它怎么写任务说明、怎么派活、怎么看结果。已有的版本会先备份。',
    skillHelp: { 'agent-router': '派活、看进度、收汇报', 'lead-workflow': '可选：让对话的模型当主导，执行者负责实现' } as Record<string, string>,
    customChoice: '已有自己改过的版本，勾选后会先备份再替换',
    next: '下一步', previous: '上一步', skip: '跳过', installNext: '安装并继续', finish: '完成', rerun: '重新运行首次引导',
    about: '让强的 Agent 当主导、把执行工作派给便宜或专长的 Agent，在这里统一派发、查看、停止和验收。',
    detecting: '正在检测…', installing: '正在安装…',
    // 本机已装版本比软件自带的新：不提供更新，避免反向降级
    newer: '比软件自带的新',
    // 引导第 2 步每一项右侧的状态
    wizardLatest: '已是最新', wizardCustom: '自己改过的版本',
    // 卡片底部平时的说明（操作完成后的"已安装 N 个"只显示 3 秒）
    customIdle: '替换前会备份',
    managed: '托管', managedHelp: '技能派发的任务默认是派活方会话的子进程，关掉会话可能连带中断任务。从本软件派发的任务总是独立运行。',
    managedToggle: '由 AgentRouter 托管任务', managedToggleHelp: '打开后，技能派出的任务由本软件启动。关掉 Claude Code 的会话，任务照常进行；要停止就在这里停。软件没开时，任务照旧由派活方启动。',
    wizardManaged: '托管任务', wizardManagedHelp: '关掉派活方的会话也不中断技能派出的任务',
    // Stage03 首次引导：检测 → 技能（含托管开关）→ 导入第一个 Agent → 添加第一个项目（O5）
    wizardSteps: ['检测', '技能', 'Agent', '项目'],
    wizardAgent: '导入第一个 Agent', wizardAgentHelp: '执行者是实际写代码的 Agent。先导入一个标着"推荐"的预设，以后可以在 Agent 页导入更多。',
    // Stage07c T0d（D60①、D73）：第 3 步测试通过后可选填每日上限；空着就是不限，不写 limits
    wizardLimitQ: '这个执行者的用量有限吗？', wizardLimitHelp: '比如订阅套餐每天只能跑几个任务。填了上限，当天用满后路由会换别的执行者；空着就是不限，以后在路由页随时改。',
    wizardLimitLabel: '每天最多', wizardLimitUnit: '个任务', wizardLimitNone: '不限', wizardLimitBad: '填 1 以上的整数，或者空着（不限）',
    // Stage07c D82（150）：第 3 步可跳过的问题"失败时想换用的强执行者"；只有一个执行者时不出下拉，只写一句说明
    wizardStrongQ: '失败时想换用的强执行者', wizardStrongHelp: '自动重试的最后一次换它来做，例如用更强的模型；不设就一直用原来的执行者，全部失败后提示主导接手。以后在路由页"兜底"随时改。',
    wizardStrongNone: '不设', wizardStrongOnly: '现在只有这一个执行者。以后导入了更强的执行者，可以在路由页"兜底"把它设为强执行者。',
    wizardAgentNext: '导入并测试', wizardNoPresets: '没有读到可用的预设，可以先跳过，之后在 Agent 页导入。',
    wizardProject: '添加第一个项目', wizardProjectHelp: '选一个 git 仓库文件夹。添加后到项目页初始化协作约定（先预览改动，确认后才写入），然后就能新建任务派发。',
    // 关闭窗口（012）：点 × 时询问；托盘
    closeTitle: '关闭 AgentRouter', closeBody: '最小化到托盘：软件留在后台，任务结束照常通知。退出：正在进行的任务照常跑完，只是不再通知。',
    closeTray: '最小化到托盘', closeQuit: '退出', closeRemember: '不再询问（可以在设置里改）',
    window: '窗口', closeAction: '点关闭按钮时', closeActionHelp: '托盘图标在任务栏右下角；右键托盘图标可以退出', closeOptions: { ask: '每次询问', tray: '最小化到托盘', quit: '退出' } as Record<string, string>,
    trayTip: (running: number) => running ? `AgentRouter · ${running} 个任务进行中` : 'AgentRouter', trayOpen: '打开 AgentRouter', trayQuit: '退出 AgentRouter',
    trayFirst: 'AgentRouter 仍在后台运行：点托盘图标打开，右键可以退出。',
    // Stage05 开工前第 1 条：主进程公共目录保护。弹窗标题；正文用核心的 unsafeHomeReason（与命令行同一句话）。
    homeUnsafeTitle: 'AgentRouter 无法启动',
    // 数据（012）：清除缓存、重置
    data: '数据', dataHelp: '排查问题或卸载前清理用。项目文件夹里的代码、任务说明和任务记录（.agent-runs）不受影响。',
    clearCache: '清除缓存', clearCacheHelp: '界面缓存、执行者的会话记录和测试连接留下的临时文件。配置、Agent、项目和任务列表都保留。',
    clearCacheButton: '清除', clearingCache: '正在后台清除…（可以继续使用软件）', cacheSkipped: (n: number) => `${n} 个文件正被占用，已跳过`, cacheCleared: (size: string) => `已清除 ${size}`, cacheNothing: '没有可清除的缓存',
    resetApp: '重置 AgentRouter', resetHelp: '删除 AgentRouter 的全部数据后退出，下次打开就像刚安装一样。卸载前做一次，可以干净卸载。', resetButton: '重置…',
    resetTitle: '重置 AgentRouter？', resetBody: '会删除下面这个文件夹里的全部内容：配置、导入的 Agent、项目列表、任务列表、执行者的配置目录与会话记录、界面缓存。完成后软件退出。',
    resetKeep: '不会删除：项目文件夹里的代码、任务说明、任务记录（.agent-runs）和 git 设置。',
    resetSecrets: '同时删除执行者用到的密钥环境变量', resetSecretsHelp: (names: string) => `Windows 用户环境变量：${names}。别的软件可能也在用，不确定就不要勾。`,
    resetSkills: '同时卸载装到 Claude Code 里的技能', resetSkillsHelp: '只删 AgentRouter 装的、装好后没被改过的技能；改过的保留。',
    resetRunning: (n: number) => `有 ${n} 个任务正在进行，先停止它们再重置。`, resetConfirm: '重置并退出', resetting: '正在重置…',
    // 清空列表（018）：任务列表、项目列表各一个按钮
    lists: '列表', listsHelp: '只清理软件里的列表，不动项目文件夹和任务记录文件。',
    clearTasks: '清空任务列表', clearTasksHelp: '已结束的任务全部从列表移除；进行中的任务保留。以后新派发的任务照常显示。', clearTasksButton: '清空…',
    clearTasksTitle: (n: number) => `清空任务列表？`, clearTasksBody: (n: number) => `${n} 个已结束的任务会从列表移除。项目里的任务记录文件不删，进行中的任务保留。`,
    clearProjects: '清空项目列表', clearProjectsHelp: '所有项目取消登记；项目文件夹和里面的文件都不动，之后可以重新添加。', clearProjectsButton: '清空…',
    clearProjectsTitle: (n: number) => `清空项目列表？`, clearProjectsBody: (n: number) => `${n} 个项目会取消登记。项目文件夹、协作约定文件和任务记录都不动。`,
    clearConfirm: '清空', tasksCleared: (n: number) => `已从列表移除 ${n} 个任务`, projectsCleared: (n: number) => `已取消登记 ${n} 个项目`, listEmpty: '列表已经是空的',
    resetLeftover: (dir: string) => `上次重置没能删完：${dir}。关掉占用它的程序后，可以手动删除这个文件夹。`,
    wizardProjectFolder: '项目文件夹', wizardProjectNone: '还没有选择', wizardOpenInit: '添加后打开初始化预览', wizardOpenInitHelp: '只预览，不会自动写入任何文件',
};

// Stage03 Agent 页（原"连接"页）：主导区沿用 p 的文案，执行者区与导入向导用这里的。
export const ag = {
    import: '导入 Agent', importFirst: '导入第一个 Agent', empty: '还没有导入执行者', emptyHelp: '执行者是实际写代码的 Agent。导入一个，设置密钥或确认登录、测试连接后就能派发任务。',
    isDefault: '默认', disabled: '已停用', enable: '启用',
    // Stage07c T2 / T3（D79）：模型与推理强度的下拉来自探针；"刷新列表"重新查；查不到时用预设值并写原因
    refreshList: '刷新列表', refreshingList: '正在查询…',
    // Stage07c T4（D85）：可担任、模型家族；T7（D83）：被限流的执行者
    canDo: '可担任', canDoHelp: '路由只在"执行者"里选；审查者候选的顺序在路由页；设为"主导"的 Agent 用来判断审查者与主导是否同家族', roleNames: { lead: '主导', executor: '执行者', reviewer: '审查者' } as Record<string, string>,
    // 2026-10-27 走查 U6：两个角色都取消时的提示（替换 agents.ts 里的占位）。
    canDoNeedOne: '至少保留一个角色才能保存', modelRangeChange: '修改…',
    // 2026-10-27 走查 U5：按核心 ar roles 的 familiesSource 写实际依据（model / host / adapter / declared）；替换 modelRangeAuto，168 换过去后删掉旧键。
    modelRangeAutoBy: (families: string, source: string) => `${families}（${({ model: '按模型名自动识别', host: '按接口地址自动识别', adapter: '按适配器默认', declared: '按声明' } as Record<string, string>)[source] ?? '自动识别'}）`,
    canDoRow: (roles: string) => `可担任 ${roles}`, familyRow: (families: string) => `家族 ${families}`, familyUnknown: '家族未知',
    modelRange: '可能用到的模型范围', modelRangeHelp: '模型认不出、或由 Agent 自己选模型（如 Auto）时用它判断家族；路由页要求"家族不同"时用它比较审查者、执行者与主导', modelRangeAuto: (families: string) => `${families}（按模型名自动识别）`,
    limitedUntil: (time: string) => `额度到 ${time} 恢复`, limitedLater: '被限流，稍后再试', limitedEvidence: (text: string) => `限流原文：${text}`,
    limitedClear: '已恢复', limitedClearHelp: '额度已经恢复时点这里，路由马上重新选它', limitedClearFail: (why: string) => `没能清除限流标记：${why}`,
    probeFrom: (source: 'api' | 'program', at: string) => `${source === 'api' ? '列表来自接口' : '列表来自程序'} · ${at} 更新`,
    // 168：导入向导第 2 步改了接口地址、密钥变量名或认证方式，之前查到的列表作废。
    probeStale: '接口地址、密钥变量或认证方式改了，点"刷新列表"重新查询',
    probeFallback: (reason: string) => `没有查到（${reason}），用预设的可选值`,
    effortSupported: (levels: string, def: string | null) => `这个模型支持 ${levels}${def ? `（默认 ${def}）` : ''}`,
    followCodex: '跟随 Codex', keySet: '已设置', keyMissing: '未设置', key: '密钥', chatgptLogin: 'ChatGPT 登录', claudeLogin: 'Claude 订阅',
    test: '测试连接', testing: '正在测试连接…', testOk: (seconds: string, version: string) => `连接成功（${seconds} 秒，${version}）`, testFail: '测试没有通过', testTimeout: '超过 3 分钟没有结束，测试已停止',
    lastTest: (time: string, text: string) => `上次测试 ${time}：${text}`,
    moreLabel: (label: string) => `${label} 的更多操作`,
    menu: { edit: '编辑', setDefault: '设为默认', disable: '停用', enable: '启用', export: '导出声明', remove: '删除' } as Record<string, string>,
    removeTitle: (label: string) => `删除执行者「${label}」？`, removeBody: '只删除 AgentRouter 里的这项配置；不卸载程序，不删除任何密钥环境变量，已有任务记录保留。', removeConfirm: '删除',
    // 导入向导（三步）
    wizardTitle: '导入 Agent', steps: ['选类型', '填参数', '测试'], pickHelp: '选一种执行者。预设已经填好接口与模型，下一步只要设置密钥或确认登录。',
    // 预设卡片的名字与说明来自预设模板（ar agents presets --json），这里不写任何服务商名（O10）。
    recommended: '推荐',
    auth: '认证方式', authToken: 'API Key', authLogin: '订阅登录', authTokenOnly: (name: string) => `${name} 只支持 API Key`,
    loginState: '登录状态', loginIn: '已登录', loginOut: (command: string) => `未登录。在终端运行 ${command} 完成登录，再点"重新检测"。`, loginUnknown: '无法确定登录状态', redetect: '重新检测',
    subscriptionShare: '订阅登录的用量计入你本人的同一份订阅',
    name: '名称', nameHelp: '命令行里用 --profile 指定它', label: '显示名', labelHelp: '列表标签取名字首词的大写字母', model: '模型', modelFollow: '留空表示跟随 Codex 自己的配置',
    baseUrl: '接口地址', secretName: '密钥环境变量', secretNameHelp: 'AgentRouter 只记变量名，不存密钥',
    secretSet: '设置密钥', secretSetHelp: '保存到 Windows 用户环境变量；保存后输入框立即清空', secretPlaceholder: '粘贴 API Key', secretSave: '保存密钥', secretSaved: '已保存',
    needSecret: '先设置密钥', needLogin: '先完成登录',
    testingLong: '正在测试连接……', testingHelp: '在临时 git 仓库里让它只回复 OK，通常几秒到一分钟，会产生少量费用。',
    testOkTitle: '连接成功', testOkHelp: (label: string, isDefault: boolean) => `${label} 已加入执行者${isDefault ? '，并设为默认执行者' : ''}。`,
    testFailHelp: '可以返回上一步修改，或重新测试。', savedNote: '配置已保存；测试通过前它仍可以被手动指定',
    elapsed: '用时', version: '执行者版本', tokens: 'token', tokensValue: (input: number, output: number) => `输入 ${input} · 输出 ${output}`, exit: '退出码',
    back: '返回修改', retest: '重新测试', done: '完成',
    // 编辑执行者（Codex 的模型、推理强度、档位、沙箱从设置页移到这里）
    editTitle: (label: string) => `编辑执行者 · ${label}`, editNote: (name: string) => `写入 config.json 的 ${name} 执行者`, save: '保存',
    maxTurns: '最大轮数', maxTurnsHelp: '留空表示不限制', labelRequired: '显示名不能为空', location: '位置',
    // 有未保存输入时关闭模态框
    discardTitle: '放弃未保存的改动？', discardBody: '关闭后，刚才填写的内容不会保存。', discard: '放弃',
};

// Stage03 项目页
export const pj = {
    title: '项目', lead: 'AgentRouter 在哪些仓库里派活', add: '添加项目', addFirst: '添加第一个项目', chooseFolder: '选择项目文件夹',
    empty: '还没有添加项目', emptyHelp: '选择一个 git 仓库文件夹。添加后可以初始化协作约定、派发任务、在项目里打开 Claude Code。',
    notInit: '未初始化', notGit: '不是 git 仓库', select: '选择一个项目',
    openClaude: '在此项目打开 Claude Code', openFolder: '打开文件夹', dirty: (n: number) => `${n} 个文件未提交`, clean: '没有未提交的改动',
    menu: { edit: '编辑配置', remove: '移除' } as Record<string, string>,
    // Stage07 116：移除还有未处理任务的项目时，在确认框里列出这些任务
    removePending: (n: number) => `这个项目还有 ${n} 个任务没处理完（待验收、合并冲突或进行中）：`, removePendingMore: (n: number) => `…等 ${n} 个`, removePendingHelp: '移除后这些任务仍留在任务列表里，驳回、确认和删除照常可以做；要合并或重试，得先把项目重新添加回来。建议先处理完再移除。',
    removeTitle: (name: string) => `移除项目「${name}」？`, removeBody: '只从 AgentRouter 的列表里移除，不删除任何文件；以后可以再添加。', removeConfirm: '移除',
    config: '项目配置', configFile: '.agent-router/project.json', edit: '编辑配置', unset: '未设置', recent: '最近任务',
    fields: { baseBranch: '主分支', setup: '准备命令', verify: '验收命令', allowedPaths: '允许改动的路径', specsDir: '任务说明目录' } as Record<string, string>,
    fieldHelp: { baseBranch: '执行者从这里开始，验收后合并回这里', setup: '每行一条；建工作区后先运行', verify: '每行一条；任务说明没写验收命令时，门禁用这里的', allowedPaths: '每行一个通配符；任务说明没写时，门禁用这里的', specsDir: '' } as Record<string, string>,
    editTitle: '编辑项目配置', editNote: '写入 .agent-router/project.json（核心校验后原子写入）', save: '保存',
    // Stage07b O4："编辑配置"底部默认折叠的"高级"区；留空表示删掉这个键、用默认值
    advanced: '高级',
    advFields: { maxRetries: '自动重试次数', mergeMode: '合并方式', verifyTimeoutMin: '验收命令超时', worktree: '用 worktree' } as Record<string, string>,
    advHelp: { maxRetries: '0～5，留空等于 2（共 3 次）', mergeMode: '批准时怎样合并到主分支', verifyTimeoutMin: '每条验收命令最多运行多少分钟，1～240，留空等于 10', worktree: '关掉后新任务在主工作区里运行、门禁通过就算完成；进行中的任务不受影响' } as Record<string, string>,
    mergeModes: { 'no-ff': '一个任务一个合并提交（--no-ff）', squash: '压成一个提交（--squash）' } as Record<string, string>,
    advDefault: (value: string) => `默认 ${value}`,
    // Stage07b O2（D34）：远程与推送。只推主分支、普通推送；落后时只快进拉取；分叉时不给按钮；凭据只用本机 git 已有的登录，软件不保存
    remoteSec: '远程', remoteRefresh: '刷新', remoteRefreshing: '正在读取远程…',
    remoteNone: '这个项目还没有远程仓库。要推送到 GitHub 等，先在终端里 git remote add origin <地址>，再回来刷新。',
    remoteSame: (branch: string, remote: string) => `${branch} 与 ${remote} 同步`, remoteAhead: (branch: string, remote: string, n: number) => `${branch} 领先 ${remote} ${n} 个提交`,
    remoteBehind: (branch: string, remote: string, n: number) => `${branch} 落后 ${remote} ${n} 个提交（只快进，不合并）`,
    remoteDiverged: (ahead: number, behind: number) => `本机和远程各有新提交（领先 ${ahead} · 落后 ${behind}），需要在终端里合并或 rebase。软件不做合并。`,
    // 155（B8）：分叉时给出两条可复制的命令，做完回来点"推送到 origin"
    remoteDivergedHow: '在项目文件夹里运行下面任意一条，解决冲突（如果有）后回到这里点"推送到 origin"：',
    remoteDivergedRebase: 'git pull --rebase', remoteDivergedRebaseHelp: '把本机的新提交接到远程后面，历史是一条直线',
    remoteDivergedMerge: 'git pull --no-rebase', remoteDivergedMergeHelp: '多一个合并提交，不改动已有的提交',
    remoteNoUpstream: (branch: string, remote: string) => `${remote} 上还没有 ${branch}，推送后会新建`,
    remoteLastPush: (time: string) => `最后推送 ${time}`, remoteNotFetched: '还没有读取远程的最新状态，点"刷新"',
    pushTo: (remote: string) => `推送到 ${remote}`, pushing: '正在推送…', pushed: (remote: string, range: string) => `已推送到 ${remote}：${range}`, pushNothing: (remote: string) => `已经和 ${remote} 一样，不用推送`,
    pull: '拉取', pulling: '正在拉取…', pulled: (n: number) => `已拉取 ${n} 个提交`, pullNothing: '已经是最新的',
    pushFailedTitle: '没有推送', pullFailedTitle: '没有拉取', pushFailedHelp: (reason: string) => `${reason}。什么都没有改动。`,
    // 155（W2）：GitHub 拒绝了暴露邮箱的推送（GH007）
    pushEmailPrivacy: (email: string) => `GitHub 拒绝了这次推送：你的账号开了"阻止暴露邮箱的命令行推送"，而要推送的提交用的是邮箱 ${email}。把提交身份的邮箱换成 GitHub 设置 → Emails 里给出的 …@users.noreply.github.com 地址，以后的提交就能推送；已经做好、还没推送的提交仍带原来的邮箱，需要在终端里改作者后再推送（见用户指南"推送被 GitHub 拒绝"）。`,
    pushEmailPrivacyNoEmail: `GitHub 拒绝了这次推送：你的账号开了"阻止暴露邮箱的命令行推送"，而要推送的提交用的邮箱不是 GitHub 给的 …@users.noreply.github.com 地址。把提交身份的邮箱换成 GitHub 设置 → Emails 里给出的那个地址，以后的提交就能推送；已经做好、还没推送的提交仍带原来的邮箱，需要在终端里改作者后再推送（见用户指南"推送被 GitHub 拒绝"）。`,
    pushEmailPrivacyAction: '修改提交身份…',
    pushNoCredential: 'git 没有拿到可用的登录，软件不会弹登录窗口。在终端里手动 git push 一次完成登录（Git Credential Manager 会记住），之后软件就能推送',
    pushCopyCommand: '复制命令', pushRetry: '重试',
    // 编辑配置：推送三项（批准合并后自动推送、允许主导推送默认都关）
    pushSec: '推送', pushRemote: '远程', pushRemoteHelp: '推送与拉取用哪个远程',
    pushAfterAccept: '批准合并后自动推送', pushAfterAcceptHelp: '验收页的确认框里默认勾上；推送失败不影响合并',
    pushAllowLead: '允许主导（AI）推送', pushAllowLeadHelp: '关闭时核心拒绝主导的推送与拉取；你在软件里点的不受影响',
    // 非 git 文件夹
    gitTitle: '这个文件夹不是 git 仓库', gitHelp: '任务要靠 git 记录改动、方便撤销。"初始化为 git 仓库"会运行 git init -b main，不改动已有文件。', gitInit: '初始化为 git 仓库',
    // 初始化：预览 → 确认写入 → 可选提交
    initTitle: '还没有初始化', initHelp: '初始化会在项目里写入协作约定（AGENTS.md 段落、角色文档、任务说明目录、项目配置）。先预览改动，确认后才写入。', init: '初始化…',
    planHelp: (added: number, updated: number) => `初始化会改动这些文件（新建 ${added} · 更新 ${updated}）。已有文件只追加带标记的段落，不覆盖。`,
    planNone: '项目已经是最新的约定，没有要改动的文件。', kindAdd: '新建', kindUpdate: '更新', notWritten: '还没有写入任何文件', confirmWrite: '确认写入', cancel: '取消',
    written: (n: number) => `已写入 ${n} 个文件`, writtenHelp: '项目已登记到 AgentRouter。要让执行者从干净的基线开始，建议把这些文件提交。',
    // Stage07b O5：已初始化项目的"更新协作约定…"。缺失 / 更新的文件照旧；和最新模板不同的角色文档逐个"备份后替换 / 保留"（默认保留）；配置缺少的新字段默认不写
    upgradeOpen: '更新协作约定…', upgradeTitle: (version: string) => `更新协作约定 · 对照 AgentRouter ${version} 的模板`,
    upgradeFilesSec: '要补上或更新的文件', upgradeRolesSec: '角色文档（你改过的内容会被替换；替换前备份到 .agent-router/backup/）',
    roleDiffTag: '和最新模板不同', roleLines: (added: number, removed: number) => `+${added} −${removed} 行`, roleReplace: '备份后替换', roleKeep: '保留',
    upgradeFieldsSec: '项目配置缺少的新字段（默认不写）',
    upgradeFieldHelp: { worktree: '打开后新任务在独立的 worktree 里运行、门禁通过后要验收；进行中的任务不受影响', setup: '准备命令：新建 worktree 后先运行，例如 npm ci', verify: '验收命令：任务说明没写验收命令时门禁用这里的', allowedPaths: '允许改动的路径：任务说明没写时门禁用这里的', specsDir: '任务说明目录', routing: '这个项目自己的路由规则' } as Record<string, string>,
    upgradeNote: (files: number, backups: number) => backups ? `会写入 ${files} 个文件（备份 ${backups} 个），还没有写入任何文件` : `会写入 ${files} 个文件，还没有写入任何文件`,
    upgradeDone: (files: number, backups: number) => backups ? `已写入 ${files} 个文件，备份了 ${backups} 个` : `已写入 ${files} 个文件`,
    missing: '文件夹不存在', missingTitle: '项目文件夹不存在', missingHelp: '文件夹可能已被移动或删除。可以从更多菜单里移除这个项目，再重新添加。', noRecent: '这个项目还没有任务',
    // Stage07b T4m（D44）：项目文件夹已被用户删掉时"彻底清理这个项目"——只清 AgentRouter 自己的记录，不删用户的任何文件
    goneTag: '文件夹已不存在', goneTitle: '项目文件夹已不存在',
    goneHelp: (path: string, tasks: number) => `${path} 找不到了（被删除或移走）。它的 ${tasks} 个任务还在任务列表里，残留的 worktree 可能还在磁盘上。如果是移走了，重新添加新位置即可；不要了就彻底清理。`,
    purgeOpen: '彻底清理这个项目…', purgeTitle: (name: string) => `彻底清理「${name}」？`,
    purgeLead: '只清理 AgentRouter 自己的记录。项目文件夹已经不存在，AgentRouter 不会删除你的任何文件。',
    purgeList: '从项目列表移除', purgeTasks: (n: number) => `从任务列表删除它的 ${n} 个任务`, purgeTasksHelp: '任务记录文件随项目文件夹一起已经不在了',
    purgeWorktrees: (n: number, size: string) => `清理残留的 worktree 与并发名额（${n} 个，约 ${size}）`, purgeWorktreesHelp: 'worktree 根目录下 AgentRouter 自己建的目录',
    purgeNote: '清理后在同一位置新建的项目从 001 开始编号', purgeConfirm: '彻底清理', purged: (name: string) => `已彻底清理「${name}」`,
    // git 提交身份（user.name / user.email）：本机设置，不需要登录 GitHub
    identityLabel: '提交身份', identityMissing: '未设置',
    identityTitle: '还没有设置 git 提交身份', identityHelp: '提交初始化文件、任务说明，以及执行者提交改动，都需要 git 的用户名和邮箱。只在本机设置，不需要登录 GitHub。',
    identitySet: '设置提交身份…', identityEditTitle: '设置 git 提交身份', identityName: '用户名', identityEmail: '邮箱', identityEmailHelp: '会写进每个提交；可以用 GitHub 提供的 noreply 邮箱',
    identityScope: '用于', identityScopes: { repo: '只用于这个项目', global: '本机所有项目（全局）' } as Record<string, string>,
    identityNote: (global: boolean) => global ? '写入你的全局 git 配置（~/.gitconfig）' : '写入这个项目的 .git/config', identitySave: '保存',
    identityNameRequired: '请填写用户名', identityEmailInvalid: '邮箱格式不对',
    // Stage07 O14（D41）：git 低于 2.40 时项目详情顶部的提示（不用 worktree 的任务不受影响，所以不拦别的操作）
    gitOldTitle: (version: string) => `git 版本太旧：${version}`,
    gitOldHelp: '用 worktree 的任务需要 git 2.40 或更新，这个项目的任务现在派发不了；不用 worktree 的任务不受影响。到 git-scm.com 下载新版，装好后重新打开 AgentRouter。',
    commitNote: (n: number) => `git commit -m "[主导] 接入 AgentRouter" -- 这 ${n} 个文件`, commit: '提交这些文件', committed: (hash: string) => `已提交 ${hash}`,
    // Stage07b O1（D35）：不用命令行的提交。项目页状态行"N 个文件未提交"旁的按钮与提交弹窗；只 git add 勾选的文件
    commitOpen: '提交…', commitTitle: (n: number) => `提交 ${n} 个文件`, commitPicked: (k: number, n: number) => `${k} / ${n} 个文件`,
    commitAll: '全选', commitKinds: { add: '新增', update: '修改', delete: '删除', rename: '重命名' } as Record<string, string>,
    commitMessage: '提交说明', commitMessageHelp: '一句话说清这次改了什么', commitMessagePh: '例如：补充 README 的安装步骤', commitMessageRequired: '请填写提交说明',
    commitDo: (n: number) => `提交 ${n} 个文件`, commitNonePicked: '至少勾选一个文件',
    commitIdentity: (name: string, email: string, global: boolean) => `提交身份：${name} <${email}>（${global ? '全局' : '只用于这个项目'}）`,
    commitDone: (hash: string, n: number) => `已提交 ${hash}（${n} 个文件）`, commitNothing: '没有未提交的文件', commitFailed: '没有提交',
    // 本机还没有全局身份时，提交身份弹窗默认"本机所有项目（全局）"，并在上面说明一句
    identityGlobalLead: '本机还没有全局身份。设一次以后，所有项目都用它，不再问。',
    // 初始化：项目还没有任何提交时，把已有的文件一起放进第一个提交（默认勾上）
    initWithExisting: (n: number, files: string) => `把已有的文件一起放进第一个提交（${n} 个：${files}）`,
    initWithExistingHelp: '遵守 .gitignore；不勾时只提交约定文件，已有文件留在"未提交"，第一次批准合并会被拒绝',
};

// Stage03 新建任务页
export const nt = {
    title: '新建任务', lead: '选项目、写清要求、选执行者',
    noProject: '先添加一个项目', noProjectHelp: '任务要在某个 git 项目里运行。添加项目后，这里可以选任务说明和执行者派发。', addProject: '添加项目',
    // 151：新建任务说明里的推理强度一行。
    effortHelp: '写进任务说明；不选就按路由规则或执行者自己的设置',
    project: '项目', source: '来源', sources: { existing: '选择已有任务说明', new: '新建任务说明', text: '直接写任务文字' } as Record<string, string>,
    specs: '任务说明', specsHelp: (dir: string) => `列出 ${dir} 下的说明，最新的在上面`, specsEmpty: '还没有任务说明。改用"新建任务说明"写一份。',
    specsArchived: (n: number) => `显示已归档的 ${n} 份`, specsArchivedHide: '收起已归档的', specsArchivedTag: '已归档',
    dispatched: (n: number) => n ? `已派发 ${n} 次` : '未派发',
    text: '任务文字', textHelp: '直接交给执行者，不生成任务说明文件；适合一次性的小事',
    titleField: '标题', titleHelp: '会成为文件名：NNN-标题.md', goal: '目标', goalHelp: '做完后是什么样子', type: '类型', types: ['code', 'test', 'fix', 'research', 'docs'],
    allowed: '允许改动的文件', allowedHelp: '每行一个通配符；先填入项目配置。门禁检查改动是否都在这里', verify: '验收命令', verifyHelp: '每行一条；先填入项目配置。执行者结束后由门禁逐条运行',
    nonGoals: '不做什么', refs: '参照', refsHelp: '相关文件、已有实现、界面稿', refsPlaceholder: '例如：docs/architecture.md', questions: '汇报要回答的问题', questionsPlaceholder: '例如：哪些步骤你没法实际验证？',
    required: (name: string) => `请填写${name}`,
    worker: '执行者', auto: (label: string) => `自动（默认：${label}）`, noWorker: '还没有可用的执行者，先到 Agent 页导入',
    commitSpec: '先提交任务说明', commitSpecHelp: '推荐：执行者从干净的基线开始，改动和说明分得清',
    // 启用门禁时（有验收命令、限定了允许路径，或类型要求提交）：门禁要从干净的基线比较改动，说明文件必须先提交。
    // 051：锁定时写出为什么会跑门禁（原因按 类型 → 验收命令 → 允许路径 的顺序用"、"连接）。
    // 表单里填了就说"有"，表单空着、用的是 .agent-router/project.json 的值就说"项目配置"。
    commitSpecForcedWhy: (reasons: string[]) => `这个任务会跑门禁（${reasons.join('、')}）：门禁从干净的基线比较改动，任务说明必须先提交`,
    gateWhyType: (type: string) => `${type} 类型要求提交`,
    gateWhyVerify: (n: number) => `有 ${n} 条验收命令`,
    gateWhyVerifyProject: (n: number) => `项目配置有 ${n} 条验收命令`,
    gateWhyPaths: '限定了允许改动的文件',
    gateWhyPathsProject: '项目配置限定了允许改动的文件',
    // 底栏后果说明的门禁后缀（接在 conseqNew / conseqExisting 后面）：没有验收命令时门禁只检查提交与改动范围
    conseqGate: (commands: number) => commands ? `；结束后跑门禁（${commands} 条验收命令）` : '；结束后跑门禁（检查提交与改动范围）',
    preview: '预览', previewTitle: '预览任务说明', previewViews: { rendered: '排版', source: '源码' } as Record<string, string>, close: '关闭', dispatch: '派发', dispatching: '正在派发…', dispatchingNote: '正在写任务说明并派发……',
    conseqText: (label: string) => `直接把这段文字派给 ${label}：在项目里直接改，不跑门禁，也不进验收页`, conseqExisting: (spec: string, label: string) => `派发 ${spec} 给 ${label}`,
    conseqNew: (spec: string, label: string, commit: boolean) => `写入 ${spec}${commit ? '，提交后' : '，'}派给 ${label}`,
    failed: '派发没有完成',
    identityWarn: '这个项目还没有设置 git 提交身份："先提交任务说明"和执行者提交改动都会失败。',
    // Stage07 T8b：允许路径输入框下面的匹配预览（ar spec check-paths；界面稿新建任务页场景"允许路径·匹配预览"）
    pathsMatched: (n: number) => `匹配到 ${n} 个现有文件：`, pathsMore: (n: number) => `，还有 ${n} 个`, pathsAll: (n: number) => `匹配项目里全部 ${n} 个文件`,
    pathsNone: (pattern: string) => `${pattern} 没有匹配到现有文件（要新建的文件可以这样写）`, pathsChecking: '正在检查匹配的文件…', pathsFailed: (reason: string) => `没能检查匹配的文件：${reason}`,
};

// Stage04 门禁（协议第 12 节）：流水线轨道、门禁标签、列表徽标、横幅。summary 由核心生成，原样显示。
export const gt = {
    tab: '门禁',
    // 流水线轨道前三段（派发 · 执行 · 门禁）；节点下的小字
    track: { dispatch: '派发', run: '执行', gate: '门禁' } as Record<string, string>,
    trackAt: (time: string) => time, trackRun: '运行中', trackExit: (exit: number | null) => exit === 0 ? '完成' : `exit ${exit}`, trackStopped: '已中断',
    trackGateOk: (passed: number, total: number) => `${passed}/${total}`, trackGateFail: '未通过', trackGating: '检查中', trackGateOff: '未启用', trackGateWait: '等待',
    // 节点按钮的 aria-label：说清状态并提示可点
    nodeLabel: (step: string, state: string) => `${step}：${state}，查看详情`,
    // 列表行第二行的门禁徽标
    badge: { ok: '门禁通过', fail: '门禁未通过', running: '门禁中' } as Record<string, string>,
    // 详情顶部横幅
    okTitle: (checks: number, commands: number, seconds: string) => `门禁通过（${checks} 项检查，${commands} 条命令，${seconds} 秒）`,
    failTitle: '门禁未通过', failHelp: '执行者已经正常结束，但核心自己检查后没有通过。看"门禁"标签了解每一项。',
    runningTitle: '门禁进行中', runningHelp: (commands: number) => `正在检查提交与改动范围${commands ? `，并逐条运行 ${commands} 条验收命令` : ''}。`,
    viewGate: '查看门禁',
    // 门禁标签里的区块
    commitSec: '提交检查', commitRequired: '要求执行者提交', commitNotRequired: '不要求提交', commitOk: (base: string, head: string) => `已提交：${base} → ${head}`, commitNone: '没有提交任何改动',
    uncommittedSec: '未提交的文件', uncommittedNone: '没有', uncommittedHelp: '执行者结束时工作区里还有这些改动没提交（不含 .agent-runs/）',
    scopeSec: '改动范围', scopeAllowed: '允许', scopeAll: '全部文件', scopeNone: '没有改动文件', scopeOutside: '超出范围', scopeCount: (changed: number, outside: number) => outside ? `${changed} 个文件，${outside} 个超出范围` : `${changed} 个文件，都在范围内`,
    // Stage05 开工前第 5 条：受保护的路径（.agent-router/ 与任务说明目录）超出范围时的行尾标注；删除的文件单独一块（只是提示）
    scopeProtected: '受保护的路径', deletedSec: '删除的文件', deletedNone: '没有', deletedNoneHelp: '这次没有删除任何文件', deletedCount: (n: number) => `${n} 个`,
    commandsSec: '验收命令', commandsNone: '没有验收命令', timedOut: '超时', truncated: '只保留了最后 200 行', ms: (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`,
    pending: '门禁结束后显示结果', missing: '没有找到门禁结果文件（gate.json）', readError: '门禁结果无法读取',
};

// Stage05 多次尝试与重试（界面稿 app/design/preview.js 的"自动重试中 / 重试历史 / 按尝试看汇报 / 重试弹窗 / 完成后再改"）
export const rt = {
    // 列表第二行：尝试 n/N（与"再派一次"的「第 N 次」标签区分）
    tag: (n: number, total: number) => `尝试 ${n}/${total}`, tagTip: (n: number, total: number) => `第 ${n} 次尝试，共允许 ${total} 次`,
    // 流水线轨道执行节点下的小字与 aria-label 里的状态
    trackRun: (n: number, total: number) => `第 ${n}/${total} 次`, trackDone: (n: number) => `第 ${n} 次完成`,
    nodeRun: (n: number, total: number) => `运行中，第 ${n} 次尝试（共允许 ${total} 次）`,
    nodeDone: (n: number) => `第 ${n} 次尝试完成，前 ${n - 1} 次没有通过，查看重试历史`,
    // 进展顶部的尝试切换条；汇报、门禁顶部的尝试下拉
    barLabel: '按尝试查看', all: '全部', nth: (n: number) => `第 ${n} 次`,
    pick: '尝试', pickOption: (n: number, latest: boolean, label: string) => `第 ${n} 次${latest ? '（最新）' : ''} · ${label}`,
    // 进展里每次尝试开头的分隔行
    sep: (n: number) => `第 ${n} 次尝试`, sepMeta: (label: string, reason: string) => `${label} · 原因：${reason}`,
    reason: { first: '首次', gate: '门禁未通过', agent: '执行者异常退出', manual: '手动重试' } as Record<string, string>,
    escalated: ' · 升级执行者',
    // "重试"标签（重试历史）
    tab: '重试', histHead: (count: number, total: number | null) => `共 ${count} 次尝试${total ? `，自动最多 ${total} 次` : ''}`, histHint: '点一行查看那一次的进展',
    rowLabel: (n: number, result: string) => `第 ${n} 次尝试：${result}，查看进展`,
    resultRunning: '进行中', resultDone: '完成', resultGateOk: '门禁通过', resultGateFail: (summary: string) => `门禁未通过：${summary}`,
    resultAgent: (exit: number | null) => `执行者异常退出（exit ${exit ?? '?'}）`, resultStopped: '已中断', tokens: (input: string, output: string) => `token ${input} / ${output}`,
    // 标题行按钮与重试弹窗（调用 ar retry --detach --json）
    button: '重试', buttonTip: '在同一工作区继续：新开一次尝试，可以补充说明或换执行者',
    title: (name: string) => `重试 · ${name}`, lastFail: '会附上上一次的失败原因',
    worker: '执行者', workerHelp: '默认沿用这个任务的执行者；可以换成更强的执行者', workerOrig: (label: string) => `${label}（原执行者）`,
    note: '补充说明', noteHelp: '可选：告诉执行者这一次要注意什么', noteHelpRequired: '已完成的任务重试时必须写：说明这一轮要改什么',
    notePh: '例如：函数名改为 add；不要修改测试文件',
    start: (n: number) => `开始第 ${n} 次尝试`, starting: '正在开始…', consequence: (gate: boolean) => `在同一工作区继续${gate ? '，结束后跑门禁' : ''}；不占自动重试的次数`,
    failed: '没有开始重试',
    // Stage06：执行者需要越界（协议 14.5）——任务详情横幅，路径逐行列在说明下面
    needsScopeTitle: '执行者认为需要改允许范围以外的文件',
    needsScopeHelp: (count: number) => `列出了 ${count} 个路径，没有再自动重试。要继续，先在任务说明里扩大允许改动的文件并提交，再点"重试"；也可以改写任务说明后重新派发。`,
    // Stage06：工作区外写入（协议 12.4）——任务详情横幅、门禁标签里的一项
    outsideTitle: '工作区外出现了新文件',
    outsideHelp: '执行者只应在工作区里写文件。下面这些是任务进行中新出现的，可能是这个执行者写的，也可能是同时进行的其他任务或其他程序。已停止自动重试，请核对；AgentRouter 不会删除或移动它们。',
    outsideGate: '工作区外的新文件', outsideRoot: { user: '用户目录', home: '公共目录' } as Record<string, string>,
    outsideUnchecked: (error: string) => `没能核对工作区外写入：${error}`,
};

// Stage06 worktree 模式：排队、准备、待验收、冲突、已合并、已驳回与验收页（界面稿 app/design/preview.js 的任务页场景与"验收"页）
export const wt = {
    // 状态名（列表标记的悬停提示、状态行开头）
    state: { queued: '排队中', preparing: '准备中', awaiting: '待验收', conflict: '合并冲突', accepted: '已合并', rejected: '已驳回' } as Record<string, string>,
    // 任务页分段筛选与列表分组
    filter: '待验收', filterTip: '待验收与合并冲突', group: '待验收',
    // 列表第二行（项目名之后）；ahead 是比它先排队、还在排队的任务数
    subQueued: (ahead: number) => ahead ? `排队中，前面还有 ${ahead} 个任务` : '排队中，下一个就轮到它',
    subAwaiting: '等你验收', subConflict: (files: number) => `${files} 个文件冲突`, subAccepted: (sha: string) => `已合并 ${sha}`, subRejected: '已驳回',
    // 详情状态行
    lineQueued: (waited: string) => `排队中 · 已等 ${waited}`, linePreparing: '准备中 · 建工作区并运行准备命令',
    lineAwaiting: (waited: string) => `待验收 · 已等 ${waited}`, lineConflict: (files: number) => `合并冲突 · ${files} 个文件`,
    lineAccepted: (time: string, by: string) => `已合并 · ${time} ${by}批准`, lineRejected: (time: string, by: string) => `已驳回 · ${time} ${by}驳回`,
    // 批准 / 驳回的人（事件里的 by：human / lead / cli）
    by: { human: '你', lead: '主导', cli: '命令行' } as Record<string, string>,
    // 流水线轨道后两段与执行节点的排队 / 准备
    track: { awaiting: '待验收', merge: '合并' } as Record<string, string>,
    trackQueued: '排队中', trackPreparing: '准备中', trackWaitYou: '等你', trackApproved: '已批准', trackRejected: '已驳回', trackConflict: '冲突', trackNoMerge: '不合并',
    nodeQueued: (ahead: number) => ahead ? `排队中，前面还有 ${ahead} 个任务` : '排队中，下一个就轮到它', nodePreparing: '建工作区并运行准备命令',
    nodeAwaitPending: '门禁通过后等待验收', nodeAwaiting: '待验收：等你批准合并或驳回', nodeApprovedConflict: '已批准，合并时冲突',
    nodeApprovedBy: (by: string) => `${by}批准`, nodeRejected: (reason: string) => `已驳回：${reason}`,
    nodeMergePending: (base: string) => `批准后合并到 ${base}`, nodeMerged: (base: string, sha: string) => `已合并到 ${base}：${sha}`,
    nodeConflict: (files: string[]) => `合并冲突：${files.join('、')}`, nodeNoMerge: '已驳回，不合并',
    // 进展标签顶部横幅
    // Stage07c T0c（D59、D77）：排队原因。改动范围重叠 / 独占门禁 / 机器正忙时替换 queuedHelp 的正文（不带"现在停止…"那半句时由界面补上 queuedStopSafe）
    // Stage07c D86（151）：验收页把互相重叠的待验收任务放在一起（ar overlaps）
    overlapGroupTitle: '这几个任务的改动范围重叠', overlapOrder: (names: string) => `建议按这个顺序批准：${names}`,
    overlapOrderHelp: '先派发的先批准；批准一个之后，后面的会自动按新基线重跑门禁，冲突的会进"冲突"。',
    queuedOverlap: (name: string, paths: string) => `与「${name}」的改动范围重叠（${paths}），等它结束后再开始，免得合并时冲突。`,
    queuedExclusive: (name: string, command: string) => `「${name}」的门禁正在独占运行（${command}），它结束后再开始。`,
    queuedBusyMem: (freeGb: string) => `可用内存不够（${freeGb} GB），暂停启动新任务，空下来后自动开始。`,
    queuedBusy: (cpu: number) => `机器正忙（CPU ${cpu}%），暂停启动新任务，空下来后自动开始。`,
    queuedStopSafe: '现在停止不会留下任何东西。',
    baseBranchRow: (branch: string) => `这次派发指定的基线分支：${branch}（不是项目主分支）`,
    queuedTitle: '排队中', queuedHelp: (limit: number, ahead: number) => `同时最多运行 ${limit} 个任务。${ahead ? `前面还有 ${ahead} 个任务，` : ''}轮到时自动开始；现在停止不会留下任何东西。`,
    preparingTitle: '准备工作区', preparingNoWorktree: '正在建立独立的 worktree 与分支。', preparingHelp: (branch: string, base: string) => `已在独立的 worktree 里建好分支 ${branch}（基线 ${base}），正在运行准备命令。`,
    worktreeRow: (branch: string, base: string, sha: string) => `建好 worktree · 分支 ${branch} · 基线 ${base} ${sha}`,
    // Stage07 111：进展里路由结果的分隔行（与 worktreeRow 同样式），文字是核心记下的路由说明原文
    routeRow: (why: string) => `路由：${why}`,
    setupFailTitle: '准备命令失败，执行者没有启动', setupFailHelp: 'worktree 保留着供排查。修好项目配置里的准备命令后点"重试"会重跑准备命令；不要这个任务了就点"驳回…"，删除 worktree 与分支。', setupFailReject: '驳回…',
    awaitingTitle: '待验收', awaitingHelp: (base: string) => `门禁通过。改动在这个任务自己的分支里，还没有合并到 ${base}；批准后合并，驳回则丢弃。`, awaitingRow: '门禁通过 · 进入待验收',
    conflictTitle: '合并冲突，没有合并', conflictHelp: (base: string, files: number) => `批准时和 ${base} 上的新提交冲突（${files} 个文件），已撤回这次合并，${base} 没有变化。`,
    acceptedTitle: (base: string) => `已合并到 ${base}`, acceptedHelp: (sha: string, time: string, by: string, _mode: string) => `合并提交 ${sha}（${time}，${by}批准）；worktree 与分支已删除。`,
    // Stage07b O3（D36）：已合并任务的"撤销这次合并…"（git revert，只追加反向提交、不改历史）
    revertOpen: '撤销这次合并…', revertTitle: (name: string) => `撤销「${name}」？`,
    revertBody: (base: string) => `会在 ${base} 上新建一个提交，把这次合并的改动反向撤回；历史不会被改写，以后还可以再撤销这个撤销。开启了"合并后推送"也不会自动推送。`,
    revertConfirm: '撤销', reverting: '正在撤销…', revertedToast: (name: string, sha: string) => `已撤销「${name}」：反向提交 ${sha}`,
    revertedTitle: '已合并 · 已撤销', revertedHelp: (merge: string, sha: string, time: string, by: string) => `合并提交 ${merge} 的改动已被反向提交 ${sha}（${time}，${by}撤销）撤回。历史没有改写；要恢复，可以在终端里撤销这个撤销。`,
    revertedState: (sha: string, time: string) => `已合并 · 已撤销（提交 ${sha}，${time}）`,
    revertConflictTitle: '没有撤销：和之后的改动冲突', revertConflictHelp: (base: string, files: string[]) => `合并之后 ${files.join('、')} 又被改过，反向提交会冲突，已放弃（git revert --abort），${base} 没有变化。需要在终端里手动处理。`,
    revertFailedTitle: '没有撤销', revertFailedHelp: (reason: string) => `${reason}。什么都没有改动。`,
    acceptedCleanup: 'worktree 或分支没能删除，留给"清理"处理；合并结果不受影响。',
    rejectedTitle: '已驳回', rejectedHelp: (reason: string, time: string, by: string, kept: string | null) => `${reason}（${time}，${by}驳回）。worktree 已删除${kept ? `，分支 ${kept} 保留` : '，分支已删除'}。`,
    goAccept: '去验收',
    // 侧栏与验收页
    nav: '验收', navTip: (n: number) => `${n} 个任务等你验收或处理冲突`,
    pageTitle: '验收', pageLead: '门禁通过的任务在这里等你批准合并或驳回', listGroup: '待验收与冲突',
    emptyTitle: '没有待验收的任务', emptyHelp: 'worktree 模式的任务门禁通过后会出现在这里，同时发一条系统通知。',
    rowWaited: (waited: string) => `已等 ${waited}`,
    tabs: { overview: '概览', diff: '改动', gate: '门禁', review: '审查' } as Record<string, string>,
    moreTip: '更多：打开 worktree、复制分支名', openWorktree: '打开 worktree 文件夹', copyBranch: '复制分支名',
    baseToHead: (base: string, from: string, to: string) => `${base} ${from} → ${to}`,
    specBox: '任务说明', specAllowed: '允许改动', specVerify: '验收命令', specAll: '全部文件', specNone: '没有',
    // Stage07b T4d⑦：只读任务（调研 / 审查，或 read_only: true）的“允许改动”：门禁按不允许任何改动处理
    specReadOnly: '只读：不允许改动',
    // 改动标签（ar diff --json）
    diffHead: (files: number, add: number, del: number) => `${files} 个文件 · +${add} −${del}`, diffOpen: '在 worktree 打开',
    diffStatus: { A: '新增', M: '修改', D: '删除', R: '重命名' } as Record<string, string>, diffRenamed: (from: string) => `从 ${from} 重命名`,
    diffBinary: '二进制文件，不显示内容', diffTruncated: '这个文件的改动太长，只显示前 200 KB', diffAllTruncated: '改动总量超过 2 MB，后面的文件只列出名字',
    diffLoading: '正在读取改动…', diffNone: '没有改动', diffGone: '改动已不可查：worktree 与分支都已删除',
    // 底部操作栏
    noteApprove: (base: string) => `批准：在 ${base} 上新建一个合并提交（--no-ff），然后删除 worktree 与分支；以后可以在任务详情里撤销这次合并`,
    noteApproveSquash: (base: string) => `批准：把改动压成一个提交放到 ${base} 上（--squash），然后删除 worktree 与分支；以后可以在任务详情里撤销这次合并`,
    noteConflict: '解决冲突在同一个 worktree 里进行，不占自动重试的次数',
    reject: '驳回…', retry: '重试…', approve: '批准并合并', resolve: '解决冲突并重试', resolving: '正在开始…',
    // Stage07 T6：调研类任务（只读运行、没有提交）门禁通过后的"确认"：不合并，只删除 worktree 与分支（界面稿场景"调研·确认"）
    researchTitle: '调研类任务：只读运行，没有改动', researchHelp: '看完汇报后点"确认"：删除 worktree 与分支，汇报和任务记录保留。不满意可以驳回，或者重试并写补充说明。',
    noteConfirm: '确认：不合并任何东西，只删除 worktree 与分支', confirm: '确认', confirming: '正在确认…',
    confirmedToast: (name: string) => `已确认「${name}」：worktree 已删除`,
    confirmedTitle: '已确认', confirmedHelp: (time: string, by: string) => `${time}，${by}确认；没有改动，worktree 与分支已删除。`,
    subConfirmed: '已确认', lineConfirmed: (time: string, by: string) => `已确认 · ${time} ${by}确认`, nodeConfirmed: (by: string) => `${by}确认（没有改动）`,
    // 批准确认
    approveTitle: (name: string, base: string) => `合并「${name}」到 ${base}？`,
    approveBody: (mode: string, branch: string) => `合并方式：${mode === 'squash' ? '--squash（压成一个提交）' : '--no-ff（一个任务一个合并提交）'}。合并后删除 worktree 与分支 ${branch}。`,
    approving: '正在合并…',
    mergedToast: (name: string, base: string, from: string, to: string) => `已合并「${name}」到 ${base}：${from} → ${to}`, undoHelp: '撤销说明', undoText: (sha: string, mode: string) => `${mode === 'squash' ? 'git revert' : 'git revert -m 1'} ${sha}`,
    // 不能合并（核心拒绝，什么都没改）：标题 + 核心返回的原文
    blockedTitle: '没有合并', blockedHelp: (reason: string) => `${reason}。什么都没有改动。`, goCommit: '去提交', copyCommand: '复制命令',
    // Stage07b O2：批准确认框里的"合并后推送"（只在项目有远程时出现），推送失败不影响合并
    approvePush: (remote: string) => `合并后推送到 ${remote}`, approvePushHelp: '默认值来自项目配置"批准合并后自动推送"；这里改只影响这一次',
    mergedPushFailed: (name: string, base: string, sha: string, reason: string) => `已合并「${name}」到 ${base}（${sha}），推送失败：${reason}。可以在项目页重试推送`,
    mergedPushed: (name: string, base: string, remote: string) => `已合并「${name}」到 ${base}，并推送到 ${remote}`, goProject: '去项目页',
    // 合并冲突（ar accept 退出码 4）：验收页横幅
    conflictPageHelp: (base: string, files: string[]) => `和 ${base} 上的新提交冲突，已撤回这次合并，${base} 没有变化。冲突的文件：${files.join('、')}。"解决冲突并重试"会在 worktree 里合并 ${base}：没有冲突就重新跑门禁；有冲突就让执行者解决，再跑门禁，之后回到这里。`,
    // 驳回弹窗
    rejectTitle: (name: string) => `驳回 · ${name}`, rejectReason: '原因', rejectReasonHelp: '写给执行者和以后的自己：为什么不合并。会写进任务记录',
    rejectPh: '例如：方向不对，主题跟随系统即可', rejectKeep: (branch: string) => `保留分支 ${branch}`, rejectKeepHelp: '以后还能看或手动合并；不勾选时分支一起删除',
    rejectNote: (base: string) => `驳回后删除 worktree；${base} 不受影响`, rejectButton: '驳回', rejecting: '正在驳回…',
    failed: '操作没有完成',
    // 系统通知：任务进入待验收；点开到验收页并选中它
    notifyTitle: (name: string) => `待验收：${name}`, notifyBody: (project: string) => `${project} · 门禁通过，等你批准合并或驳回`,
    notifyConflict: (name: string) => `合并冲突：${name}`,
};

// Stage06 搜索与排序、侧栏底部执行者负载、设置页"并行"与"清理"（界面稿 app/design/preview.js 的"搜索 / 排序菜单"场景、nav()、设置页"有可清理项 / 清理确认"）
export const s6 = {
    // 任务页搜索与排序
    taskSearch: '搜索任务名、目标、项目', clearSearch: '清除搜索', clear: '清除',
    taskFound: (n: number, q: string) => `${n} 个任务包含"${q}"（任务名、目标、项目）`, taskNone: (q: string) => `没有任务包含"${q}"`,
    sortTip: (label: string) => `排序：${label}`,
    taskSorts: { time: ['按时间', '最近的在上'], state: ['按状态', '待验收、进行中、失败在上'], project: ['按项目', '同一项目放在一起'] } as Record<string, [string, string]>,
    // 项目页搜索与排序
    projectSearch: '搜索项目名、路径', projectFound: (n: number, q: string) => `${n} 个项目包含"${q}"（名称、路径）`, projectNone: (q: string) => `没有项目包含"${q}"`,
    projectSorts: { recent: ['最近使用', '最近派过任务的在上'], name: ['名称', ''], added: ['添加时间', ''] } as Record<string, [string, string]>,
    // 分段筛选"失败"的悬停提示写全称；最窄窗口不显示数量时也写在提示里
    filterTip: (label: string, n: number) => `${label} ${n} 个`, failTip: '失败或中断',
    // 侧栏底部：每个执行者一行"名字  运行数/上限"，再一行托管
    loadRow: (n: number, limit: number) => `${n}/${limit}`,
    loadTip: (label: string, n: number, limit: number) => `${label} 正在运行 ${n} 个任务；同时最多运行 ${limit} 个（设置里的并发上限）`,
    // 设置页"并行"
    parallelSec: '并行', parallelLead: '用 worktree 模式的项目，每个任务在自己的工作区里运行，可以同时进行。',
    // Stage07c T0c（D59、D77）："自动 / 固定"分段 + 固定时 1～8 的下拉；自动时显示估算值与是否暂停，另有自动档的上限
    concurrencyModes: { auto: '自动', fixed: '固定' } as Record<string, string>,
    concurrencyAutoNow: (n: number, cores: number, freeGb: string) => `现在估算 ${n} 个（${cores} 核、可用内存 ${freeGb} GB）`,
    // 2026-10-27：实际使用中这一行只会因为可用内存不够才出现（preferences.mjs 的 machineLoad），按原因写，不要写成 CPU。
    concurrencyAutoBusyMem: (freeGb: string) => `可用内存只有 ${freeGb} GB，暂停启动新任务；已经在跑的不受影响`,
    concurrencyAutoBusy: (cpu: number) => `机器正忙（CPU ${cpu}%），暂停启动新任务；已经在跑的不受影响`,
    concurrencyMax: '自动时最多', concurrencyMaxHelp: '自动估算不会超过这个数。',
    concurrencyFixedHelp: '固定时同时最多运行这么多个任务（1～8）。',
    concurrencyFixed: '固定数量', concurrencyAuto: '自动估算',
    concurrencyAutoHelp: '按 CPU 核数与可用内存估算；CPU 连续 1 分钟超过 85% 或可用内存低于下面的比例时暂停启动新任务。',
    // D114（2026-10-28）：自动档"内存不够"的比例可调，写进 config.json；下限 1.5 GB 不变
    memLowPercent: '内存不够时暂停', memLowPercentHelp: (gb: string) => `可用内存低于总内存的这个比例（且不低于 1.5 GB）时不启动新任务；这台电脑现在是 ${gb} GB。`,
    memLowPercentOption: (n: number) => `低于 ${n}%`,
    concurrency: '同时运行的任务', concurrencyHelp: '超出时排队，轮到时自动开始；门禁同一时间只跑一个。不用 worktree 的项目不受这个限制。',
    // 设置页"数据"里的"清理"（ar gc）
    gc: '清理', gcHelp: (days: number) => `已合并、已驳回任务没删掉的 worktree，项目文件夹已经不存在的任务留下的 worktree，和超过 ${days} 天的执行者会话记录。`,
    gcIdle: '软件启动时检查，不会自动删除。没有可清理的内容。', gcFound: (n: number, size: string) => `发现 ${n} 项可以清理，约 ${size}`,
    gcChecking: '正在检查…', gcCheckFailed: (error: string) => `没能检查：${error}`,
    gcButton: '清理…', gcRecheck: '重新检查',
    gcTitle: (n: number) => `清理 ${n} 项？`,
    gcLead: (size: string) => `会删除下面这些 worktree 与会话记录，约 ${size}。正在运行和待验收的任务不受影响；项目主工作区、任务记录（.agent-runs）不动。`,
    gcReason: { accepted: '已合并，没删掉', rejected: '已驳回，没删掉', 'unknown-task': '任务记录已找不到', prunable: 'git 记录里的目录已不在', 'repo-missing': '项目文件夹已不存在', slot: '占用者已退出的名额' } as Record<string, string>,
    gcSessionReason: (days: number) => `超过 ${days} 天的会话记录`,
    gcSession: (worker: string, date: string) => `${worker} · ${date}`,
    gcConfirm: '清理', gcRunning: '正在清理…',
    gcDone: (n: number, size: string) => `已清理 ${n} 项，约 ${size}`, gcPartial: (failed: number) => `；${failed} 项没删掉（可能正被占用），下次再试`,
};

// Stage07 O4 / O5：路由页与新建任务页"执行者：自动"的路由结果（界面稿 app/design/preview.js 路由页场景"规则 / 添加规则 / 试算·为什么选它 / 已达每日上限 / 没有规则"，新建任务页场景"自动·路由结果"）
export const ro = {
    nav: '路由', title: '路由', lead: '按任务类型自动选执行者', addRule: '添加规则', addFirst: '添加第一条规则',
    // Stage07c T5（D84）：路由建议。T6：规则的推理强度
    suggest: '按我的执行者生成建议规则', suggestTitle: '建议规则', suggestLead: '根据你已导入、启用并测试通过的执行者生成。勾选后点"采用"才写入。',
    suggestAdopt: (n: number) => `采用 ${n} 条`, suggestNote: '只写入勾选的条目；已有规则不动，和已有规则冲突的条目不出现',
    suggestNone: '没有可以建议的规则：先导入并测试通过至少一个执行者。', suggestSkipped: (text: string) => `没有列出：${text}`,
    suggestAdopted: (n: number) => `已采用 ${n} 条建议规则`, suggestHint: '可以按你的执行者生成建议规则（路由页）',
    effortUnsupported: '这个执行者不支持推理强度，已忽略',
    ruleEffort: '推理强度', ruleEffortHelp: '可选：这条规则派出的任务用这个强度；任务说明或单次派发写了时以它们为准。选项来自所选执行者', ruleEffortNone: '不指定',
    // 151：换执行者后原来的推理强度不在新选项里（规则弹窗与新建任务表单共用）。
    effortReset: (old: string) => `推理强度 ${old} 不在这个执行者的选项里，已改为不指定`,
    types: { code: '代码', test: '测试', fix: '修复', refactor: '重构', research: '调研', docs: '文档', review: '审查' } as Record<string, string>,
    rulesSec: '规则', rulesLead: '按顺序匹配：任务说明指定了执行者时直接用它；否则找第一条类型相符、执行者可用的规则；都不符合时用兜底。停用、不支持只读、今天已达上限的执行者会被跳过。',
    emptyTitle: '还没有规则', emptyHelp: (label: string) => `所有任务都派给默认执行者 ${label}。按任务类型分给不同的执行者，就添加一条规则。`,
    escTo: (label: string) => `升级到 ${label}`, noEsc: '不升级',
    moveUp: (n: number) => `上移第 ${n} 条`, moveDown: (n: number) => `下移第 ${n} 条`, edit: (n: number) => `编辑第 ${n} 条`, remove: (n: number) => `删除第 ${n} 条`,
    stateDisabled: '已停用', stateNoReadOnly: '不支持只读', stateLimited: '今天已达上限', stateMissing: '执行者不存在',
    projectRules: (project: string, n: number) => `项目 ${project} 另有 ${n} 条自己的规则（写在 .agent-router/project.json），派发这个项目的任务时排在上面这些之前。`,
    ruleSheetAdd: '添加规则', ruleSheetEdit: (n: number) => `编辑第 ${n} 条规则`,
    ruleTypes: '任务类型', ruleTypesHelp: '可以选多个；一个类型只认第一条符合的规则', ruleTypesRequired: '至少选一个任务类型',
    ruleTo: '执行者', ruleToHelp: '调研、审查类任务只能选支持只读的执行者', ruleEsc: '升级到', ruleEscHelp: '可选：最后一次自动重试改用它',
    ruleNote: '写进 config.json 的 routing.rules，加在最后', ruleAdd: '添加', ruleSave: '保存',
    fallbackSec: '兜底', fallback: '兜底执行者', fallbackHelp: (label: string) => `没有规则符合时派给它；不设时用默认执行者（${label}）`, fallbackNone: '用默认执行者',
    trialSec: '试算', trialLead: '不派发，只看会派给谁、为什么。', trialType: '任务类型', trialProject: '项目', trialAny: '不限项目',
    trialResult: (label: string) => `将派给 ${label}`, trialWhy: '为什么选它', trialFail: '没有可用的执行者',
    limitsSec: '每日上限', limitsLead: '到上限的执行者当天不再接任务，路由跳到下一条规则或兜底；第二天自动恢复。留空为不限。',
    limitTasks: '任务数', limitTokens: 'token', limitNone: '不限', limitInvalid: '填正整数，或留空表示不限',
    usedTasks: (n: number, max: number | null) => max ? `今天 ${n}/${max} 个任务` : `今天 ${n} 个任务`, usedTokens: (n: string, max: string | null) => max ? ` · ${n} / ${max} token` : ` · ${n} token`,
    reviewSec: '审查者候选', reviewLead: '交叉审查（v0.8.0 起）按顺序取第一个可用的；必须支持只读。', reviewAdd: '添加', reviewRemove: (label: string) => `移除 ${label}`,
    // D128（2026-10-29 用户决定）：三条约束都由用户决定，可以关
    reviewDiffer: '不能是执行者本人', reviewDifferHelp: '关掉后，同一个 Agent 也可以审查自己做的任务',
    reviewDifferFamily: '与执行者的模型家族不同', reviewDifferFamilyHelp: '同一个模型家族审查自己的改动，容易带着同样的盲点；关掉后只看上一条',
    // Stage07c T4（D80、D85）：审查者的模型家族默认也与主导不同；T8（D82）：强执行者
    reviewDifferLead: '与主导的模型家族不同', reviewDifferLeadHelp: '在 Agent 页给某个 Agent 勾上"主导"就按它的家族算；都没勾时按 Claude Code（claude 家族）',
    leadNow: (lead: string, families: string) => `现在的主导：${lead}（家族 ${families}）`, leadDefault: '未设置，按 Claude Code',
    strong: '强执行者', strongHelp: '自动重试的最后一次改用它；不设时最后一次仍用原执行者，都失败就提示主导接手', strongNone: '不设',
    // 新建任务页"执行者：自动"
    autoByRule: '自动（按路由规则）', hint: (label: string, why: string) => `将派给 ${label}（${why}）`, hintWhy: '为什么', hintFail: (reason: string) => `派发不了：${reason}`,
    whyRule: (scope: string, n: number, types: string) => `${scope}规则 ${n}：${types}`, whyFallback: '兜底', whySpec: '任务说明指定', whyExplicit: '手动指定',
    scopeProject: '项目', scopeGlobal: '全局',
};

// Stage07 O6 / O7：导入向导扩展——OpenAI 兼容接口、Qoder、自定义 CLI、从文件导入；模型与推理强度下拉；自定义 CLI 表单与"测试并预览"（界面稿 Agent 页场景"导入 1 新类型 / 导入 2 选模型与推理强度 / OpenAI 兼容接口 / 自定义 CLI / 测试并预览 / 编辑 Claude 类执行者"）
export const gx = {
    // 第 1 步两种不是预设的类型（预设卡片的名字与说明来自预设模板）
    custom: '自定义 CLI', customDesc: '任意有非交互模式的命令行 Agent，填表接入，不用写代码',
    fromFile: '从文件导入', fromFileDesc: '导入别人导出的声明文件（.json，不含密钥）', chooseFile: '选择声明文件…',
    // 模型与推理强度下拉
    model: '模型', modelHelpCli: (cli: string) => `列表来自 ${cli}；也可以选"自定义…"自己填`, modelHelpPreset: '常用值；也可以选"自定义…"自己填',
    modelLoading: '正在读取模型列表…', modelCustom: '自定义…', modelCustomPh: '输入模型名',
    effort: '推理强度', effortDefault: '默认', effortDefaultDesc: '不传参数', effortHelp: (cli: string) => `"默认"表示不传这个参数，由 ${cli} 自己决定`,
    // OpenAI 兼容接口
    baseUrl: '接口地址', baseUrlHelp: '可以从常用地址里选，也可以自己填', wireApi: '接口类型', wireApiValue: 'Responses',
    wireApiHelp: 'Codex 只支持 Responses 接口；只提供 Chat Completions 的服务请改用"Claude Code 兼容后端"或自定义 CLI',
    openaiNote: '经 Codex 外壳运行，不需要 ChatGPT 登录；沿用你的 Codex 配置目录',
    // Qoder
    qoderTokenHelp: (site: string, name: string) => `在 ${site} 的账户集成页生成个人访问令牌，保存到用户环境变量 ${name}`,
    // 自定义 CLI 表单
    customTitle: '导入 Agent · 自定义 CLI', program: '程序', programHelp: '程序名（在 PATH 里查找）或完整路径', browse: '浏览…',
    programFound: (version: string) => `已找到 · ${version}`, programMissing: '找不到这个程序', programChecking: '正在检测…',
    detectArgs: '检测参数', detectArgsHelp: '退出码 0 视为已安装，第一行输出当作版本',
    argsTpl: '参数模板', argsTplHelp: '任务指令用 {prompt}（直接作参数）或 {promptFile}（写进临时文件再传路径；指令长、或程序是 .cmd 时用它）',
    argAdd: '输入后回车', argRemove: (arg: string) => `删除参数 ${arg}`, insert: '插入：',
    stdin: '标准输入', stdinHelp: '不需要时留空', stdinPh: '例如 {prompt}',
    // Stage07b T4d⑪：空输入框里的灰色示例按 → 键填入（不占用 Tab）；字段说明末尾加一句提示，输入框聚焦且为空时右侧显示按键提示
    examples: { stdin: '{prompt}', readOnly: '--read-only', secretVar: 'EXAMPLE_API_KEY' } as Record<string, string>,
    exampleHint: '空着时按 → 填入示例', exampleKey: '→ 填入',
    outFormat: '输出格式', formats: { text: '文本', jsonl: 'JSONL', 'stream-json': 'Claude Code 风格' } as Record<string, string>,
    mapping: '事件映射', mappingHelp: 'JSONL 每一行按顺序找第一条符合的规则；都不符合的行丢弃（原样保存在 raw.log）', mapAdd: '添加一条', mapRemove: (n: number) => `删除第 ${n} 条映射`,
    mapWhen: '条件', mapKind: '事件', mapFields: '字段',
    kinds: { say: '说话', think: '思考', cmd: '命令', file: '文件', plan: '计划', tool: '工具', turn: '用量', error: '错误' } as Record<string, string>,
    reportFrom: '汇报来源', reports: { stdout: '标准输出', lastSay: '最后一句话', file: '汇报文件 {report}' } as Record<string, string>,
    readOnlyArgs: '只读参数', readOnlyArgsHelp: '不填时它不能做调研、审查类任务', readOnlyPh: '例如 --read-only',
    secretVar: '密钥环境变量', secretVarHelp: '可选；只写变量名', secretVarPh: '例如 EXAMPLE_API_KEY',
    testPreview: '测试并预览', customNote: (name: string) => `保存为 config.json 的 generics.${name}，可以在"⋯ → 导出声明"里导出`,
    invalid: (n: number) => `声明有 ${n} 处问题，改好后才能保存`,
    // 测试并预览
    previewTitle: '导入 Agent · 测试并预览', rawOut: '原始输出', mapped: '映射结果', unmatched: (n: number) => `第 ${n} 行没有符合的规则，已丢弃`,
    previewOk: '测试通过', previewOkHelp: (exit: number, seconds: string, report: string) => `退出码 ${exit}，用时 ${seconds} 秒；汇报：${report}`,
    previewFail: '测试没有通过', retest: '重新测试', backEdit: '返回修改',
    // 导出
    exportDone: (file: string) => `已导出到 ${file}`, exportTitle: '导出声明',
    // 执行者"编辑"里的升级目标（用户 2026-10-24 同意做进软件）
    // 107 执行者用文案待定占位的几处（主导补）
    nameInvalid: '名称只能用小写字母、数字和连字符（不能以连字符开头），最长 40 个字符', nameTaken: (name: string) => `已经有叫 ${name} 的执行者，换一个名称`,
    whenFormat: (part: string) => `条件「${part}」要写成"键 = 值"，多个用逗号分隔`, fieldsFormat: (part: string) => `字段「${part}」要写成"字段 ← 路径"，多个用 · 分隔`,
    genericEditNote: '这里只改显示名、模型、推理强度和升级目标。程序、参数、映射这些声明内容要改的话：⋯ → 导出声明，改好后再从文件导入。',
    escalate: '升级到', escalateHelp: '可选：这个执行者的任务最后一次自动重试改用它；路由规则里写了"升级到"时以规则为准', escalateNone: '不升级',
};

// Stage07 O8（D33）：设置页"网络代理"（界面稿 app/design/preview.js 设置页场景"代理·跟随系统 / 代理·系统代理未开启 / 代理·手动填写"）
export const px = {
    sec: '网络代理', lead: '对"在此项目打开 Claude Code"和派发的执行者生效；已经打开的终端和运行中的任务不变。',
    row: '代理', modes: { off: '不使用', system: '跟随系统代理', manual: '手动填写' } as Record<string, string>,
    offHelp: '不设置也不清除代理变量，照旧继承',
    systemFound: (url: string) => `当前读到：${url}（Windows 系统代理）`, systemNone: '当前：系统代理未开启，不使用代理', systemUnreadable: '当前：读不到系统代理设置，不使用代理',
    manualHelp: '只支持 http://、https://、socks5:// 加主机和端口',
    url: '代理地址', urlPlaceholder: 'http://127.0.0.1:7890', save: '保存', saved: '已保存',
    errCredentials: '地址里不能带用户名和密码，这类代理请自己设环境变量',
    errFormat: '地址格式不对：例如 http://127.0.0.1:7890',
    errEmpty: '先填写代理地址',
};

// Stage06 链路报告第一版：任务详情"评分"标签与设置页"评分"一节（界面稿 app/design/preview.js 的"评分 / 评分·归因到任务说明"场景）
export const sc = {
    tab: '评分', executor: '执行者', lead: '主导', reviewer: '审查者', reviewerCrossed: (name: string, crossed: boolean) => `${name}${crossed ? '（交叉）' : '（非交叉）'}`,
    reviewPerfIssues: '问题', reviewPerfIssuesValue: (n: number, h: number, m: number, l: number) => `${n} 个（高 ${h} · 中 ${m} · 低 ${l}）`,
    reviewPerfValid: '成立', reviewPerfValidValue: (ok: number, all: number) => `${ok} / 已确认 ${all}`, outOf: '/ 100', scoreLabel: (n: number) => `综合分 ${n}`,
    // 每一项的名称（键同 ar report --json 的 key）
    items: {
        attemptGate: '多一次尝试：门禁未通过', attemptAgent: '多一次尝试：执行者异常退出', outsideFile: '越界文件', protectedFile: '动了受保护的路径',
        outsideWrites: '工作区外写入', escalated: '升级了执行者', toolError: '工具报错', needsScope: '写了"需要越界"',
        specEdit: '派发后改任务说明', specBlame: '门禁失败归因到任务说明', manualRetry: '手动重试', rejected: '驳回', conflict: '合并时冲突',
        // Stage07 O12（D39）：归因到"环境"的门禁失败，两张卡片各列一行，不扣分
        envBlame: '环境原因',
        // Stage08 T6b（D93）：审查者一组
        reviewInvalid: '改了文件（审查无效）', reviewFormat: '没按格式给结论', reviewFalse: '被标为"不成立"的问题', reviewFalseHigh: '被标为"不成立"的高严重度问题',
    } as Record<string, string>,
    // 主导一节里"需要越界"的名称与执行者不同（含义是范围划窄了）
    leadNeedsScope: '执行者写了"需要越界"',
    count: (n: number) => `${n} 次`, files: (n: number) => `${n} 个`, none: '没有', yes: '有', needsScopeFree: '（写了也不扣）', envFree: '（不扣分）',
    escalatedAt: (n: number) => `第 ${n} 次升级`, noAcceptance: '不用 worktree，没有验收', notYet: '还没验收',
    capFailed: '任务最终失败，执行者最多 40 分', capRejected: '被驳回，执行者最多 60 分',
    // 性能
    perfTime: '用时', perfToken: 'token', perfCost: '估算费用', perfTools: '工具调用', perfLeadTime: '派发到结束', perfAwait: '待验收到验收',
    tokens: (input: string, output: string) => `${input} / ${output}`, toolCalls: (n: number) => `${n} 次`, noPrice: '没有设置价格', noTokens: '没有统计',
    leadUsageOff: '没有统计（设置里打开后统计）', leadUsageUnavailable: '找不到派发会话的记录',
    // 门禁失败归因
    blameSec: '门禁失败归因', blameHelp: '任务说明写错或漏写导致的改成"任务说明"，扣分从执行者移到主导；与双方都无关的偶发失败改成"环境"，两边都不扣',
    blameRow: (n: number) => `第 ${n} 次`, blameWhy: (summary: string) => `门禁未通过：${summary}`, blameLabel: (n: number) => `第 ${n} 次门禁失败归因`,
    blameWorker: '执行者', blameSpec: '任务说明', blameEnv: '环境', blameFailed: '没有改成归因',
    // 怎么算
    how: '综合分怎么算',
    howText: '满分 100，按上面每一项扣分，最低 0；最终失败时执行者最多 40 分，被驳回时最多 60 分。用时、token、费用只列出来，不进分数（不同模型价格差太多）。每一项扣多少写在 config.json 的 reportWeights 里，可以改。主导的 token 要在设置里打开"统计主导的 token 与用时"才读。',
    loading: '正在计算…', unavailable: '这个任务没有评分', running: '任务结束后显示评分',
    // 设置页
    settingsSec: '评分', leadUsage: '统计主导的 token 与用时',
    leadUsageHelp: '任务详情"评分"里主导一节要用。只读 Claude Code 自己的会话记录里的数字（按派发会话和任务的时间段），不复制任何内容。默认关闭。',
};

// Stage03 主进程调用核心（console 通道）的错误文案；核心自己的错误已经是中文，原样显示。
export const cx = {
    invalid: '参数无效，操作没有执行', noResult: '核心没有返回结果', unknownProject: '这个项目没有登记，先在项目页添加',
    // Stage07 116：任务的项目已从列表移除时，合并、重试、再派一次、合并主分支后重跑的提示（与 c.projectGoneBlocked 同一句）
    projectGoneBlocked: '项目已从项目列表移除，先重新添加项目',
    failed: (reason: string) => `没有启动核心：${reason}`, timeout: (seconds: number) => `核心没有在 ${seconds} 秒内返回，操作已停止`,
};

// Stage08 交叉审查（158 用；界面稿 app/design/preview.js 的 reviewTab / reviewBadge / reviewSettings，主导决定 D92）
export const rv = {
    tab: '审查', none: '这个任务没有审查', noneHelp: '任务说明写 review: true，或在路由页打开"默认审查所有任务"。',
    verdict: { pass: '审查通过', concerns: '审查发现问题，只供参考', fail: '审查不通过', unknown: '没审成', invalid: '审查无效', skipped: '没有审查' } as Record<string, string>,
    badge: { pass: '审查通过', fail: '审查不通过', unknown: '没审成', invalid: '没审成', skipped: '没审成' } as Record<string, string>,
    badgeIssues: (n: number) => `审查 ${n} 个问题`,
    // D125（2026-10-28 用户决定）：窄时徽标只显示图标与数字，悬停与读屏写全
    badgeIssuesFull: (n: number) => `审查：${n} 个问题`,
    node: '审查', nodePass: '通过', nodeIssues: (n: number) => `${n} 个问题`, nodeFail: '不通过', nodeUnknown: '没审成', nodeRunning: '审查中',
    nodeHelpUnknown: '没有可用的审查者或审查失败，不影响验收',
    by: (reviewer: string, crossed: boolean, dur: string) => `${reviewer} 审查${crossed ? '（交叉：与执行者使用不同的 Agent 配置）' : '（非交叉：与执行者使用同一个 Agent 配置）'}，用时 ${dur}。`,
    severity: { high: '高', medium: '中', low: '低' } as Record<string, string>,
    valid: '成立', invalid: '不成立', note: '说明（可选）', jump: '跳到改动里的这一行',
    reviewed: '看过的文件', again: '再审一次…', againTitle: '再审一次', againHelp: '用最近一次的提交与门禁结果，换一个审查者或同一个再审；不改任务状态。',
    overviewRow: '审查', notCrossed: '（非交叉）',
    needsHuman: '审查问题未解决，需人工处理',
    needsHumanHelp: (ids: string) => `拦截模式下审查发现高严重度问题，自动返工后仍有：${ids}。审查只是意见，你可以把问题标为"不成立"后批准，或者驳回、重试。`,
    approveUnconfirmed: (n: number, ids: string) => `审查还有 ${n} 个高 / 中问题没有确认（${ids}）。可以照常批准；确认结果用来统计审查者的准确率。`,
    // 路由页
    defaultAll: '默认审查所有任务', defaultAllHelp: '关着时只审任务说明里写了 review: true 的任务；调研类任务不审',
    block: '审查发现问题时', blockHelp: '建议模式：只记录，不打回，由你验收时判断；拦截：高严重度问题自动返工',
    blockModes: { none: '只建议', high: '高严重度拦截' } as Record<string, string>,
    maxReworks: '最多返工几次', maxReworksHelp: '拦截模式下由审查触发的返工次数，不占门禁的自动重试次数；用完还有问题就交给你',
    accuracy: '审查者准确率（你和主导标的"成立 / 不成立"）', accuracyRow: (all: number, ok: number) => `已确认 ${all} 条 · 成立 ${ok} 条`,
    accuracyNone: '还没有确认过的审查问题',
    suggestBlock: (reviewer: string) => `${reviewer} 的高严重度问题已确认 20 条以上、准确率 80% 以上，可以考虑开启高严重度拦截。开关由你决定。`,
    suggestBlockHelp: '某个审查者的高严重度问题已确认 20 条以上、准确率 80% 以上时，这里会提示"可以考虑开启高严重度拦截"。开关始终由你决定。',
    // 158 汇报里的占位（2026-10-28 主导补）："再审一次"弹窗、跳到改动找不到这一行
    rerunAuto: '按规则自动选', rerunReviewer: '审查者', rerunning: '正在审查…',
    rerunNone: '没有可以担任审查者的执行者：在 Agent 页给一个支持只读的执行者勾上"审查者"。',
    jumpNoLine: '改动里没有这一行，已定位到这个文件的开头',
};
