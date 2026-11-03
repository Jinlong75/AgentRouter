<p align="center"><img src="app/design/icons/app.svg" width="96" alt=""></p>
<h1 align="center">AgentRouter</h1>
<p align="center"><a href="#中文">中文</a> · <a href="#english">English</a></p>

> 状态：**v1.0.0 候选（未发布）**；上一个发布 v0.8.0。候选版本已合入统计、主导可替换、项目目标、三个技能与 DeepSeek Harness 部署。本仓库仅包含运行、构建与测试所需的文件。
>
> Status: **v1.0.0 release candidate (unreleased)**; the previous release is v0.8.0. The candidate includes statistics, a replaceable lead, project targets, three skills and DeepSeek Harness deployment. This repository contains only the files needed to run, build and test the project.

## 中文

主导不必使用Claude Code：能读取项目约定并调用`ar`的交互式Agent也可以手动在项目目录工作。命令行可以用 `ar lead set` 选择主导、用 `ar lead plan` 算出启动参数，`ar lead open` 算出参数并记录启动；软件里也能选主导并一键打开：Agent 页的"主导"卡片选择当前主导，项目页的"在此项目打开 <名字>"按 `ar lead open` 的启动参数打开它（Claude Code、Codex、Qoder 等声明了交互启动的通用 CLI；程序是 `.cmd` / `.bat` 批处理包装时软件暂时不能代开，终端里按 `ar lead plan` 运行）。选主导不会切换已经打开的会话。

### 项目介绍

AgentRouter 是一个 Windows 桌面软件加一组 Claude Code 技能（派发与验收、主导工作流、主导经验清单）：用户选定的强 Agent 当主导，负责方案、拆解、验收；能写清楚要求的执行工作，路由给便宜或专长的 Agent（DeepSeek、Xiaomi MiMo、Codex 等）。软件是统一调度中心：导入 Agent、添加项目、新建任务派发、查看进度与汇报、停止与再派一次，都能在软件里完成。

本项目基于 [DispatchDock](https://github.com/LBEILC/DispatchDock) v0.1.5（MIT）。

### 功能

| 功能 | 状态 |
|---|---|
| 派发任务（任务说明文件或任务文字），后台运行；进度、统一事件、汇报 | ✅ |
| `ar wait` 等待、`ar stop` 停止整棵进程树；托管（关掉 Claude Code 会话也不中断） | ✅ |
| 统一入口 `ar`：`verify · research · dispatch · scope · next · redispatch · retry · wait · stop · accept · reject · push · pull · revert · diff · status · overlaps · report · stats · gc · config · init · projects · agents · secrets · spec · route · roles · lead · review · proxy · version · help`，`--json` 供软件调用 | ✅ |
| `ar init`：在任意 git 仓库生成项目配置与约定文件（幂等、不覆盖） | ✅ |
| 技能安装器：安装、更新、备份、回退（Claude Code） | ✅ |
| 执行者：DeepSeek、Xiaomi MiMo（经 Claude Code 外壳）、Codex、OpenAI 兼容接口、Qoder，以及用通用适配器零代码接入的任意 CLI Agent；密钥只记变量名 | ✅ |
| 调度中心：任务页、Agent 页（导入向导、测试连接）、项目页（添加、初始化、提交）、新建任务页、再派一次、批量删除 | ✅ |
| 任务说明规范与机器门禁：执行者结束后，核心自己检查提交、改动范围并逐条运行验收命令；软件显示流水线轨道与门禁结果 | ✅ |
| 自动重试与升级：失败原因交回执行者、同一工作区再试，每次尝试留档；`ar retry` 与软件"重试"、尝试切换与重试历史 | ✅ |
| worktree 隔离、并行与验收合并：每个任务独立的 worktree 与分支、准备命令、并行与排队、验收页、`ar diff · accept · reject · gc · status`；执行者需要越界时停下、工作区外写入检查；任务评分（`ar report`）；任务与项目的搜索排序 | ✅ |
| 接入与路由：通用适配器（零代码接入任意 CLI Agent：导入向导填表、"测试并预览"、声明导出与导入）；Qoder（国内版 / 国际版）与 OpenAI 兼容接口预设；导入与编辑时选模型、推理强度和"升级到"；按任务类型自动选执行者的路由页（规则、兜底、试算、每日上限）；调研 / 审查任务只读运行与"确认"；设置页网络代理；门禁失败可归因到环境；合并主分支后重跑门禁 | ✅ |
| 项目的 git 操作：软件里提交、推送与快进拉取（从不强制推送）、批准时合并后推送、撤销合并；项目配置"高级"区；更新协作约定；归档任务说明 | ✅ |
| 执行者与路由增强：导入与编辑时从账号实际可用的列表选模型与推理强度（导入前就能查）、Codex 编辑改成表单式；"可担任"（主导 / 执行者 / 审查者）与模型家族；路由页按你的执行者生成建议规则、一键采用；任务说明与路由规则可以写推理强度和模型，参数标签写明来源；额度用完 / 限流时自动换人并标"额度到 HH:MM 恢复"，便宜执行者最后一次重试换强执行者；并行调度（自动档按 CPU 与内存、改动范围重叠时排队、独占命令）；与待验收任务改动重叠时提示，合并后自动按新基线重跑门禁；执行者给出结果后不退出时自动收尾 | ✅ |
| 交叉审查：门禁通过后按用户配置的身份和模型家族约束选择审查者，只读审查，问题按严重度列出；验收页与任务详情的"审查"标签（成立 / 不成立、跳到改动里的那一行、再审一次）、轨道节点与列表徽标；默认只建议，可选高严重度拦截与自动返工；审查者准确率；评分加审查者一组 | ✅ |
| 统计与执行者价格：`ar stats` 按执行者、任务类型与推理强度分组，给出通过率、耗时、token 与费用；软件"统计"页显示整体效果、执行者分组、主导分组、趋势与价格，可填单价重算费用；审查者准确率在路由页看，评分汇总用 `ar stats --json` | ✅ v1.0（未发布） |
| 主导可替换：`ar lead set` 选择主导，`ar lead plan` 按命令行、项目与执行者配置算出启动参数，`open` 另记录这次启动 | ✅ v1.0（未发布） |
| 项目目标：`ar init --target` 生成 `.agent-router/target.md`（最终目标、里程碑、不做什么、预算、截止时间），已有文件不覆盖 | ✅ v1.0（未发布） |
| 三个技能：新增 `lead-practices`；安装器与设置页统一安装、更新、备份、回退，旧版 DispatchDock 技能可备份后删除 | ✅ v1.0（未发布） |
| DeepSeek Harness 部署：`ar agents deploy deepseek-harness` 检测已有的 `dsh` 或装进自己的目录，自动导入预设并测试连接 | ✅ v1.0（未发布） |
| 默认路由：没有规则命中时分两步挑。调研、杂务先在已启用、可担任执行者、测试连接通过、填了单价的执行者里挑单价最低的（调研还要支持只读，这一步不看预设的任务类型）；其余类型、以及单价这一步没有结果时，再按执行者预设建议的任务类型自动选；审查类任务没有规则命中时用兜底。币种不同不比较 | ✅ v1.0（未发布） |
| 全量验收：`ar verify` / `ar verify --last`，自上次通过以来合入 5 个任务后（默认，`fullVerifyEvery` 可改）在 `ar accept` / `ar next` 里提示；结果对应运行时的提交，运行期间分支或提交变了作废；项目配置了 `fullVerify`（命令数组，可配 `fullVerifyTimeoutMin`）时跑它，否则跑 `verify`；`ar verify --require` 只读确认当前提交已通过（合入 / 发布前用） | ✅ v1.0（未发布） |
| 受管调研：`ar research "<问题>" --files <glob…>` 按已跟踪文件分批派只读调研，`ar research collect <调研名>` 把各批汇报汇总到任务目录的 `summary.md` | ✅ v1.0（未发布） |
| 并发自动调整：自动档在任务结束后按最近几次采样的 CPU 与内存升降上限（1～`concurrencyMax`），`ar next` / `ar wait` 显示"并发上限 <旧>→<新>（<原因>）"；`ar config` 可设 `autoAdjustSamples`、`autoAdjustCpuPercent`、`autoAdjustMemoryMarginGb` | ✅ v1.0（未发布） |
| 主导严格模式：`ar lead brief` / `ar lead ack`；项目开 `leadStrict` 时，派发、重试、合入、驳回前必须先确认 | ✅ v1.0（未发布） |
| 必填项与测试削弱检查：项目配置 `specRequired` / `reportRequired`；任务说明 `report_sections` 要求汇报某几节有内容；门禁比较 `base..HEAD`，删测试、断言净减少、超时变大要在汇报的 `## 断言改写` 里逐个说明；门禁自动反向实验由 `mutations_required` 规定至少几条 | ✅ v1.0（未发布） |
| 验收与重试增强：合入前硬检查；`ar accept --ack "…"` 确认有内容的汇报小节，确需覆盖时 `--force --reason "…"`；`ar scope approve` 一步批准越界并重试；`ar spec impact [--docs]` 列出受影响的测试与文档 | ✅ v1.0（未发布） |
| v1.0 其他：代提交、`ar retry --regate`（待验收、门禁未通过或门禁阶段被停止的 worktree 任务）、`ar wait --timeout`、`ar status --json` 汇报计数、`ar config` 并发设置、结果信号只采集 | ✅ v1.0（未发布） |
| 软件里的主导选择与首次引导中的 Harness 部署步骤：Agent 页"主导"卡片、项目页"在此项目打开 <名字>"；首次引导第 4 步与 Agent 页卡片可选版本、看进度与已用时间、随时取消，失败自动退回旧版本 | ✅ v1.0（未发布） |

### 技术栈

| 层 | 技术 |
|---|---|
| 核心引擎 `core/` | Node.js ESM，零第三方依赖，Node ≥ 24；软件里用 Electron 内置 Node 运行 |
| 主导接入 | Claude Code Skills（`SKILL.md`，三个技能）；主导本身可选 Claude Code、Codex 或其他有交互启动方式的 CLI Agent（`ar lead`） |
| 执行者 | 经 Claude Code CLI 的模型（`claude-code` 适配器）、Codex CLI 与 OpenAI 兼容接口（`codex`）、Qoder、DeepSeek Harness 与任意 CLI Agent（`generic`）；测试与演示用 `fake` |
| 桌面软件 | Electron + TypeScript + esbuild，渲染层原生 HTML/CSS/TS |
| 打包 | electron-builder（NSIS，x64） |
| 测试 | `node:test`、假执行者、真实事件样例回放、真实输入的界面检查 |

### 架构

```
Claude Code（主导）── 技能 agent-router（SKILL.md + core/）──┐
                                                            ├─► core/ar.mjs ─► 本机文件协议（无网络端口）
AgentRouter 软件（调度中心，内置 Node 运行 core/）──────────┘     %APPDATA%\agent-router\{config.json, runs.jsonl, projects.json}
                                                                 <项目>\.agent-router\project.json
                                                                 <项目>\.agent-runs\<任务>\{progress.log, report.md, events.jsonl, raw.log}
                                                                        │
                                                                        ▼
                                                              执行者进程（适配器：claude-code / codex / generic / fake）
```

适配器写法见 [`core/adapters/README.md`](core/adapters/README.md)。

### 从源码运行

**环境要求**：Windows 10 / 11、Git、[Node.js](https://nodejs.org/) 24 或更新。真正派发任务需要至少一个执行者（DeepSeek / MiMo 需要 Claude Code CLI，Codex 需要 Codex CLI）。

```powershell
git clone https://github.com/Jinlong75/AgentRouter.git
cd AgentRouter
npm ci
npm run demo      # 用演示数据打开软件，不碰你真实的任务和技能；首次运行会下载 Electron
npm run fonts     # 打安装包前先取界面字体（需联网）
npm run dist      # 打 NSIS 安装包到 release/
```

**技能**：`npm run pack:skills` 打出技能 ZIP，解压后运行 `node installer/install.mjs` 把三个技能安装到 Claude Code（已有版本先备份，`--rollback` 撤销）。

**命令行**（与软件读写同一份配置与记录）：

```powershell
cd C:\work\my-app                                  # 任意 git 仓库
node <技能目录>\core\ar.mjs init --dry-run          # 先看会改哪些文件
node <技能目录>\core\ar.mjs init
node <技能目录>\core\ar.mjs agents add --preset deepseek
node <技能目录>\core\ar.mjs dispatch "在 README.md 末尾加一行并提交"
```

### 任务说明与门禁

任务说明是项目里的 `docs/specs/NNN-简述.md`（软件"新建任务 → 新建任务说明"会帮你写）。开头的 frontmatter 告诉 AgentRouter 这次允许改哪些文件、怎样算做完：

```markdown
---
id: 012
title: 给登录页加"记住我"
type: code
allowed_paths:
  - src/auth/**
  - tests/auth/**
verify:
  - npm test -- tests/auth
---

## 目标
## 不做什么
## 验收标准
```

- `allowed_paths`、`verify` 不写时用项目配置 `.agent-router/project.json` 的 `allowedPaths`、`verify`。字段写错时派发会直接报错并给出行号。
- **门禁**：执行者以 0 结束后，由核心自己检查结果，不依赖执行者的自我汇报——①没有留下未提交的文件；②要求提交的类型（code / test / fix / refactor）确实提交了；③改动的文件都在 `allowed_paths` 里；④逐条运行 `verify` 命令（一条失败不中断，一次看到全部问题）。结果写进任务目录的 `gate.json`，软件任务详情的"门禁"标签逐项显示。全部通过才算完成；没通过时任务为失败，`ar dispatch` / `ar wait` 退出码为 `3`，并打印一句原因。
- 退出码 `3` 表示门禁未通过；执行者自己也可能以 `3` 退出，判断是否门禁未通过以 `--json` 结果里的 `gate` 字段为准。
- 任务说明有验收命令、允许路径或类型要求提交时会跑门禁。非只读文字任务在启用 worktree 时使用项目配置的验收命令和允许路径，门禁通过后待验收；只读文字任务跑只读门禁，不用 worktree。关闭 worktree 的普通文字任务不跑门禁。
- 任务说明须已提交；非 worktree 门禁还要求工作区干净（`.agent-runs/` 除外）。软件新建任务页会自动先提交任务说明。
- Windows 上验收命令不经 shell：`npm`、`npx` 用 Node 直接运行；其他 `.cmd` / `.bat` 的参数里有 `&`、`|`、`%` 等特殊字符时拒绝运行。验收命令拿不到执行者的密钥变量，也拿不到 AgentRouter 自己的环境变量。

### 失败后会发生什么

用任务说明派发的任务，没通过时不会马上算失败，AgentRouter 会在**同一个工作区**再试：

1. **自动重试**：门禁没通过，或执行者异常退出时，核心把失败原因原样交给执行者，包括哪条验收命令失败及其输出末尾、哪些文件越界、哪些没提交，然后让它接着改。默认最多再试 2 次（共 3 次）；任务说明写 `max_retries: N`，或项目配置写 `maxRetries`，可以改，`0` 表示不重试。执行者根本没能启动（缺密钥、找不到程序）或任务被停止时不重试。
2. **换更强的执行者**：执行者配置写 `escalate: "<另一个执行者>"` 时，最后一次自动重试改用它。目标没有启用就不换，进度里会说明。第一次重试也可能就是最后一次。
3. **每次尝试都留档**：`.agent-runs/<名>/attempts/<n>/` 里有这次实际发出的指令 `prompt.md`、原始输出、汇报和门禁结果；任务目录顶层的 `report.md`、`gate.json` 是最近一次的。软件里，列表行显示"尝试 n/N"；任务详情有尝试切换条，可以按次看进展、汇报和门禁；"重试历史"每次一行。
4. **手动重试**：自动重试用完仍失败，或者结果不满意，可以在软件里点"重试"（可以换执行者、写补充说明），或运行 `ar retry <记录名> --note "补充说明"`。已完成的任务重试时必须写补充说明。任务还在进行时不能重试，先停止。
5. **重试不会绕过门禁**：每次都完整跑门禁。`.agent-router/` 与任务说明目录受保护，执行者改它们算越界，除非 `allowed_paths` 明确写了这个目录。删除的文件会单独列出来，方便你检查有没有删测试。
6. **需要越界时停下**：执行者认为必须改允许范围以外的文件才能完成时，在汇报里写一节 `## 需要越界`，逐行列出路径。核心看到这一节就不再自动重试，任务停下等你决定：扩大允许范围后手动重试、改任务说明，或者放弃。
7. **工作区外写入**：每次尝试前后各列一遍用户目录根和公共目录根的第一层文件。多出新文件时门禁标红、不再自动重试，提醒你核对。只看文件名和修改时间，不读内容，也不删除。

### 任务是怎样被隔离和合并的

项目配置 `.agent-router/project.json` 写了 `"worktree": true` 时（`ar init` 生成的配置默认如此），符合 worktree 条件的任务（包括非只读文字任务）不在你的工作区里改代码：

1. **独立的 worktree 与分支**：每个任务在项目外的 git worktree 里运行（Windows 默认在 `%LOCALAPPDATA%\agent-router\wt\`），分支是 `ar/<记录名>`，基线默认是项目配置的主分支 `baseBranch`，派发时可用 `--base <分支>` 选择本次基线。执行者默认在独立 worktree 中工作，你可以继续编辑主工作区；worktree 本身不构成操作系统权限隔离，实际访问边界取决于执行者的沙箱与权限配置。任务说明要先提交到所选基线，执行者才看得到它。
2. **准备命令**：新 worktree 里没有依赖。项目配置的 `setup`（例如 `["npm ci"]`）在 worktree 建好后逐条运行。失败时执行者不启动，worktree 留着供排查；修好后点"重试"会重跑准备命令，不要这个任务了就驳回。
3. **并行与排队**：同时运行的任务默认最多 2 个，可以在设置页"并行"或 `config.json` 的 `concurrency` 里改（1～8，或"自动"：按 CPU 核数与可用内存估算，机器正忙时暂停启动新任务）。多出来的任务排队，轮到时自动开始。门禁默认同一时间运行一个，可用 `gateConcurrency` 调整。
4. **待验收**：门禁通过后任务进入"待验收"，改动还在任务自己的分支里。在软件的"验收"页看概览、改动和门禁结果，然后选一个：
   - **批准并合并**（`ar accept <记录名>`）：在主分支上新建一个合并提交（`--no-ff`；项目配置写 `"mergeMode": "squash"` 时压成一个提交），然后删除 worktree 与分支。撤销整个任务：任务详情里点"撤销这次合并…"，或 `ar revert <记录名>`（只追加一个反向提交）。主工作区必须在主分支上而且干净，否则什么都不改，并说明原因。
   - **驳回**（`ar reject <记录名> --reason "…"`）：写明原因，删除 worktree；分支可以选择保留。
   - **重试**：和失败后的手动重试一样，在同一个 worktree 里继续。
5. **合并冲突**：批准时如果和主分支上的新提交冲突，会撤回这次合并，主分支不变，任务标为"合并冲突"。"解决冲突并重试"（`ar retry <记录名> --rebase`）在 worktree 里合并主分支：没有冲突就重新跑门禁；有冲突就让执行者解决、再跑门禁，之后回到待验收。
6. **清理**：`ar gc` 列出并删除已合并、已驳回、任务记录已找不到的 worktree，以及残留的名额文件。软件启动时检查一次，在设置页"清理"确认后才删除。10 分钟以内新建的目录不算残留。
7. **评分**：任务结束后，任务详情的"评分"标签（`ar report <记录名>`）给执行者和主导各打一个 0～100 的分。分数按事件扣分，每一项都列出来；门禁失败可以归因到任务说明，扣分就从执行者移到主导。

单个任务不想用 worktree 时，派发加 `--no-worktree`。

### 接入新的 Agent 与路由

**接入一个新的 Agent，三步**（Agent 页 → 导入 Agent）：

1. **选类型**：内置预设（DeepSeek、Xiaomi MiMo、Claude、Codex、Qoder 国内版 / 国际版、OpenAI 兼容接口），或者**自定义 CLI**——任何有非交互模式的命令行 Agent，填程序、参数模板（`{prompt}`、`{promptFile}`、`{model}`、`{effort}` 等占位符）和输出格式（文本、JSONL 加事件映射、Claude Code 风格），不写代码。
2. **选模型和推理强度，保存密钥**：配置里只记环境变量名，密钥值存进 Windows 用户环境变量。
3. **测试**：预设跑"测试连接"；自定义 CLI 跑"测试并预览"，左边是原始输出，右边是映射出的进展。通过后就能派活。声明可以"导出声明"给别人，对方"从文件导入"；文件里没有密钥。

命令行同样能做（`ar agents add --preset …`、`ar agents import <文件>`），声明的全部字段见 [`core/adapters/README.md`](core/adapters/README.md)。

**路由**：一个任务派给谁，按这个顺序决定——手动指定 → 任务说明的 `worker` → 项目规则 → 全局规则（按任务类型）→ 预设默认规则（没有规则命中时，调研、杂务先按同币种最低单价挑，其余类型以及单价这一步没有结果时按预设建议的任务类型挑）→ 兜底 → 默认执行者。停用的、今天达到每日上限的、只读任务里不支持只读的执行者会被跳过。"路由"页可以排规则、设兜底与每日上限、"试算"某类任务会派给谁、为什么；命令行是 `ar route --type test --explain`。

**调研任务只读**：`research` / `review` 类型或写了 `read_only: true` 的任务以只读方式运行，门禁要求没有任何改动；验收时点"确认"，只删除 worktree 与分支，不合并。

**网络代理**：设置页"网络代理"可选不使用 / 跟随系统代理 / 手动填写，对派发的执行者与在项目里打开的主导都生效。

**评分归因**：门禁失败可以归因到执行者、任务说明或环境（例如机器过载导致的计时失败）。落后于主分支导致的门禁失败可以 `ar retry <记录名> --rebase`：将任务选定的基线分支合入 worktree：没有冲突时不启动执行者，直接重跑门禁；有冲突时由执行者解决冲突，再跑门禁。

### 主导、统计与项目目标

- **选择主导**：`ar lead set <执行者名>` 把已启用、可担任主导、并且适配器支持交互启动（`claude-code`、`codex` 或带 `interactive` 声明的 `generic`）的配置设为当前主导；`ar lead show` 查看，`ar lead clear` 清除。`ar lead plan --project <路径> [--model <模型>] [--effort <级别>]` 按"命令行 > 项目配置 > 执行者配置 > 工具默认"算出启动参数，`ar lead open` 另把这次启动记进公共目录的 `leads.jsonl`（只记启动参数，不记会话 ID 或密钥）。软件里也能选主导：Agent 页的"主导"卡片选择当前主导，项目页的"在此项目打开 <名字>"打开它；程序是批处理包装时按 `ar lead plan` 给出的命令在终端运行。
- **三个技能**：`agent-router`（派发与验收）、`lead-workflow`（分工模式）、`lead-practices`（主导经验清单）；安装器与设置页统一安装、更新、备份、回退，软件里的技能卡片与首次引导显示版本与状态，旧版 DispatchDock 技能可备份后删除。
- **统计**：`ar stats [--range 7d|30d|all] [--project <路径>] [--json]` 按执行者、任务类型与推理强度分组，给出样本数、通过率与 Wilson 95% 区间、平均尝试次数、门禁失败归因、越界率、升级率、中位耗时、每个已合并任务的平均 token 与费用、审查者准确率；少于 5 个样本标"数据不足"。另有按角色评分、按天趋势、按主导分组与整体效果（每周合并数、端到端中位时长、人工介入、费用、主导与执行者 token 之比）。软件的"统计"页按所选范围显示整体效果、执行者分组、主导分组、趋势与价格，可填每百万 token 的单价并立即重算；审查者表目前显示"暂无按审查者分组的数据"，审查者准确率在路由页看，评分汇总用 `ar stats --json`。价格与用量缺一项时如实标为算不出。合并后被撤销、验收后 7 天内修到同一批文件的提交目前只采集。
- **项目目标**：`ar init --target`（已有项目用 `ar init --upgrade --target`）生成 `.agent-router/target.md`，写最终目标、里程碑与完成条件、不做什么、预算、截止时间；已有文件不覆盖，派发、门禁与验收不读取它。
- **其他 v1.0**：执行者配置打开 `autoCommit` 后，该提交却没提交时由 AgentRouter 在门禁前提交改动的文件；`ar retry --regate` 让待验收、门禁未通过或门禁阶段被停止的 worktree 任务不重新启动执行者，重跑门禁；开了审查的任务在提交有变化时门禁通过后重新审查；`ar wait --timeout` 支持超时；`ar status --json` 带汇报计数；`ar config` 可设置并发；审查约束的三个开关可分别关闭。

### DeepSeek Harness

`ar agents deploy deepseek-harness` 先检测 PATH 里的 `dsh`；没有就装进 AgentRouter 自己的目录（不做全局安装、不改 PATH），装好自动导入预设并测试连接。`--cleanup` 与 `undeploy` 清理 AgentRouter 管理的目录。软件首次引导第 4 步与 Agent 页卡片也能安装：可选版本、看进度与已用时间、随时取消；不兼容时提示原因并可改装验证过的版本，升级失败自动退回旧版本。

### 开发与测试

```powershell
npm run lint:tree        # 目录整洁检查
npm run verify           # 类型检查 + 全部 node:test
npm run shots            # 真实输入的界面检查并截图到 app/dist/shots/
npm run shots -- --from stats   # 分段续跑：从某一段（stats、audit、tail）跑到结尾，只用于确认修复，不能代替完整检查
npm run fonts            # 从官方来源取界面字体（不进仓库）
```

### 致谢与许可证

基于 LBEILC 的 [DispatchDock](https://github.com/LBEILC/DispatchDock)（MIT）。字体与图标库的声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。许可证：[MIT](LICENSE)。

---

## English

The lead does not have to use Claude Code: another interactive agent can work in the project directory if it can read the project conventions and invoke `ar`. On the command line, `ar lead set` chooses the lead and `ar lead plan` works out the launch arguments and `ar lead open` also records the launch. The app can do this too: choose the lead on its card on the Agents page, then open it from the Projects page with "Open <name> in this project", which uses the `ar lead open` launch arguments (Claude Code, Codex, Qoder and other generic CLIs whose declaration has an interactive launch; when the program is a `.cmd` / `.bat` wrapper the app cannot open it yet, so run the `ar lead plan` command in a terminal). Assigning the lead role does not switch a running session.

### Introduction

AgentRouter is a Windows desktop app plus a set of Claude Code skills (dispatch and acceptance, the lead workflow, and a lead-practices checklist). A user-selected strong agent leads: it plans, breaks down work and reviews results, and routes clearly specified execution work to cheaper or specialised agents (DeepSeek, Xiaomi MiMo, Codex and others). The app is the dispatch console: import agents, add projects, dispatch new tasks, follow progress and reports, stop or re-dispatch — all from the app.

Based on [DispatchDock](https://github.com/LBEILC/DispatchDock) v0.1.5 (MIT).

### Features

| Feature | Status |
|---|---|
| Dispatch work (spec file or task text) in the background; progress, unified events and reports | ✅ |
| `ar wait`, `ar stop` for the whole process tree; managed mode (tasks survive closed Claude Code sessions) | ✅ |
| Single entry `ar`: `verify · research · dispatch · scope · next · redispatch · retry · wait · stop · accept · reject · push · pull · revert · diff · status · overlaps · report · stats · gc · config · init · projects · agents · secrets · spec · route · roles · lead · review · proxy · version · help`, `--json` for the app | ✅ |
| `ar init`: project config and conventions for any git repository (idempotent, never overwrites) | ✅ |
| Skill installer: install, update, back up, roll back (Claude Code) | ✅ |
| Workers: DeepSeek, Xiaomi MiMo (through Claude Code), Codex, OpenAI-compatible APIs, Qoder, and any CLI agent through the generic adapter without code; only key variable names are stored | ✅ |
| Dispatch console: Tasks, Agents (import wizard, connection test), Projects (add, initialise, commit), New Task, re-dispatch, batch delete | ✅ |
| Task specs and machine gates: after the worker exits, the core itself checks commits and changed files and runs each verify command; the app shows a pipeline track and the gate result | ✅ |
| Automatic retry and escalation: failures handed back to the worker, retried in the same tree, every attempt kept; `ar retry` and Retry in the app, attempt switcher and retry history | ✅ |
| Worktree isolation, parallel runs and accept/merge: one worktree and branch per task, setup commands, parallel runs and a queue, an Accept page, `ar diff · accept · reject · gc · status`; stop when the scope is too narrow, check for writes outside the working tree; task scores (`ar report`); search and sort for tasks and projects | ✅ |
| Adding agents and routing: a generic adapter (any CLI agent without code — fill in a form in the import wizard, "Test and preview", export and import declarations); Qoder (China / international) and OpenAI-compatible presets; pick a model, reasoning effort and an escalation target when importing or editing; a Routing page that picks the worker by task type (rules, fallback, try-out, daily limits); read-only research and review tasks with Confirm; a network proxy setting; gate failures can be blamed on the environment; re-run the gate after merging the latest commits of the task's base branch | ✅ |
| Project git operations: commit, push and fast-forward pull (never a force push), push after merging when approving, and revert a merge in the app; an Advanced section in the project config; update the collaboration conventions; archive task specs | ✅ |
| Better agents and routing: pick a model and reasoning effort from what your account can actually use when importing or editing (even before importing), and a form-style Codex editor; "Can act as" (lead / worker / reviewer) and model families; the Routing page suggests rules from your agents and adopts them in one click; task specs and routing rules can set reasoning effort and model, and the parameter tag shows where each value came from; switch agents automatically on quota or rate limits and mark "quota back at HH:MM", and move the last retry of a cheap worker to a strong one; parallel scheduling (automatic by CPU and memory, queue when changed files overlap, exclusive commands); warn when a task overlaps one awaiting acceptance and re-run its gate on the new base after a merge; clean up a worker that stays running after giving its result | ✅ |
| Cross review: after the gate passes, a reviewer selected under the configured identity and model-family constraints reviews the change read-only and lists issues by severity; a Review tab on the Accept page and in task details (valid / invalid, jump to the changed line, review again), a track node and list badges; advisory by default, with optional blocking on high severity and automatic rework; reviewer accuracy; a reviewer group in the score | ✅ |
| Statistics and worker prices: `ar stats` groups by worker, task type and reasoning effort with pass rate, duration, tokens and cost; the Statistics page shows the overall effect, groups by worker, groups by lead, the trend and prices, and prices can be filled in to recalculate costs; reviewer accuracy is on the Routing page and the score summary is available through `ar stats --json` | ✅ v1.0 (unreleased) |
| Replaceable lead: `ar lead set` chooses the lead; `ar lead plan` works out the launch arguments from the command line, project and worker profile, and `open` also records the launch | ✅ v1.0 (unreleased) |
| Project target: `ar init --target` writes `.agent-router/target.md` (final goal, milestones, out of scope, budget, deadline); existing files are never overwritten | ✅ v1.0 (unreleased) |
| Three skills: `lead-practices` is new; the installer and Settings install, update, back up and roll back all three, and old DispatchDock skills can be deleted after a backup | ✅ v1.0 (unreleased) |
| DeepSeek Harness deployment: `ar agents deploy deepseek-harness` detects an existing `dsh` or installs into its own folder, then imports the preset and tests the connection | ✅ v1.0 (unreleased) |
| Implicit routing: when no rule matches, it can be disabled and applies only when a task has a type; it works in two steps. For research and chore, first pick the lowest-priced worker among those that are enabled, can act as workers, passed the connection test and have a price set (research must also support read-only; this step ignores the preset's task types); for other types, and when the price step finds no one, pick by the task types a worker's preset suggests. Prices in different currencies are not compared. Review tasks without a matching rule go to the fallback. | ✅ v1.0 (unreleased) |
| Full verify: `ar verify` / `ar verify --last`, suggested in `ar accept` / `ar next` once 5 tasks have been merged since the last passing run (default; `fullVerifyEvery` changes it); each result belongs to the commit it ran on and is voided if the branch or commit changes during the run; runs the project `fullVerify` command list when configured (per-command limit `fullVerifyTimeoutMin`), otherwise `verify`; `ar verify --require` is a read-only check that the current commit has passed (use before merging or releasing) | ✅ v1.0 (unreleased) |
| Managed research: `ar research "<question>" --files <glob…>` dispatches read-only research over tracked files in batches, and `ar research collect <name>` writes the batch reports into `summary.md` in the task folder | ✅ v1.0 (unreleased) |
| Automatic concurrency adjustment: in auto mode the limit moves up or down after each finished task based on the last few CPU and memory samples (1–`concurrencyMax`); `ar next` / `ar wait` show the "并发上限 <old>→<new>（<reason>）" line; `ar config` accepts `autoAdjustSamples`, `autoAdjustCpuPercent` and `autoAdjustMemoryMarginGb` | ✅ v1.0 (unreleased) |
| Lead strict mode: `ar lead brief` / `ar lead ack`; with `leadStrict` in the project config, dispatch, retry, accept and reject need a confirmation first | ✅ v1.0 (unreleased) |
| Required sections and test-weakening checks: `specRequired` / `reportRequired` in the project config; a spec's `report_sections` requires those report sections to have content; the gate compares `base..HEAD` and deleted tests, fewer assertions or larger timeouts must be explained file by file in a `## 断言改写` report section; `mutations_required` sets the minimum number of automatic gate mutation experiments | ✅ v1.0 (unreleased) |
| Better acceptance and retries: pre-merge hard checks; `ar accept --ack "…"` confirms report sections with content and `--force --reason "…"` overrides a failure; `ar scope approve` approves out-of-scope requests and retries in one step; `ar spec impact [--docs]` lists the affected tests and documents | ✅ v1.0 (unreleased) |
| Other v1.0 work: delegated commits, `ar retry --regate` (worktree tasks awaiting acceptance, with a failed gate, or stopped during the gate), `ar wait --timeout`, report counts in `ar status --json`, concurrency keys in `ar config`, and result signals collected only | ✅ v1.0 (unreleased) |
| Lead selection in the app and the Harness deployment step in the first-run wizard: the lead card on the Agents page, "Open <name> in this project" on the Projects page; wizard step 4 and the Agents page card offer version selection, progress with elapsed time, cancellation, and automatic fallback to the previous version on failure | ✅ v1.0 (unreleased) |

### Tech stack

| Layer | Technology |
|---|---|
| Core engine `core/` | Node.js ESM, zero third-party dependencies, Node ≥ 24; inside the app it runs on Electron's embedded Node |
| Lead integration | Claude Code Skills (`SKILL.md`, three skills); the lead itself can be Claude Code, Codex or another CLI agent with an interactive launch mode (`ar lead`) |
| Workers | Models through the Claude Code CLI (`claude-code` adapter), Codex CLI and OpenAI-compatible APIs (`codex`), Qoder, DeepSeek Harness and any CLI agent (`generic`); `fake` for tests and demos |
| Desktop app | Electron + TypeScript + esbuild, plain HTML/CSS/TS renderer |
| Packaging | electron-builder (NSIS, x64) |
| Testing | `node:test`, fake worker, replay of real event samples, real-input UI checks |

### Architecture

```
Claude Code (lead) ── skill agent-router (SKILL.md + core/) ──┐
                                                              ├─► core/ar.mjs ─► local file protocol (no network ports)
AgentRouter app (console, runs core/ on embedded Node) ───────┘     %APPDATA%\agent-router\{config.json, runs.jsonl, projects.json}
                                                                   <project>\.agent-router\project.json
                                                                   <project>\.agent-runs\<task>\{progress.log, report.md, events.jsonl, raw.log}
                                                                          │
                                                                          ▼
                                                                worker process (adapter: claude-code / codex / generic / fake)
```

The adapter contract is in [`core/adapters/README.md`](core/adapters/README.md).

### Running from source

**Requirements**: Windows 10 / 11, Git, [Node.js](https://nodejs.org/) 24 or later. Real dispatching needs at least one worker (DeepSeek / MiMo need the Claude Code CLI, Codex needs the Codex CLI).

```powershell
git clone https://github.com/Jinlong75/AgentRouter.git
cd AgentRouter
npm ci
npm run demo      # opens the app with demo data, without touching your real tasks or skills; downloads Electron on first run
npm run fonts     # fetch the interface fonts before building the installer (needs network)
npm run dist      # builds the NSIS installer into release/
```

**Skills**: `npm run pack:skills` builds the skills ZIP; unzip it and run `node installer/install.mjs` to install all three skills into Claude Code (existing versions are backed up first; `--rollback` undoes it).

**Command line** (shares configuration and records with the app):

```powershell
cd C:\work\my-app                                  # any git repository
node <skill folder>\core\ar.mjs init --dry-run      # see which files would change
node <skill folder>\core\ar.mjs init
node <skill folder>\core\ar.mjs agents add --preset deepseek
node <skill folder>\core\ar.mjs dispatch "append a line to README.md and commit"
```

### Task specs and gates

A task spec is `docs/specs/NNN-name.md` in your project (the app's New Task → New spec writes one for you). Its frontmatter tells AgentRouter which files may change and what "done" means:

```markdown
---
id: 012
title: Add "remember me" to the login page
type: code
allowed_paths:
  - src/auth/**
  - tests/auth/**
verify:
  - npm test -- tests/auth
---

## Goal
## Out of scope
## Acceptance criteria
```

- Without `allowed_paths` / `verify`, the project's `.agent-router/project.json` (`allowedPaths`, `verify`) applies. A malformed field stops the dispatch with the line number.
- **Gate**: after the worker exits with 0, the core checks the result itself rather than relying on the worker's own report — ① no uncommitted files are left; ② types that must commit (code / test / fix / refactor) did commit; ③ every changed file matches `allowed_paths`; ④ each `verify` command is run (a failure does not stop the rest, so you see every problem at once). The result goes to `gate.json` in the task folder and the task's Gate tab in the app shows each item. Only a full pass counts as done; otherwise the task fails, `ar dispatch` / `ar wait` exit with `3` and print a one-line reason.
- Exit code `3` means the gate failed; a worker may also exit with `3` on its own, so use the `gate` field in the `--json` result to tell whether the gate failed.
- Spec tasks run the gate when they have verify commands, restricted paths or a type that must commit. Non-read-only text tasks use the project verify commands and allowed paths when worktree is enabled, and await acceptance after the gate passes. Read-only text tasks run a read-only gate without a worktree. Ordinary text tasks without worktree do not run a gate.
- A dispatched spec must be committed; non-worktree gates also require a clean working tree (except `.agent-runs/`). The app's New Task page commits the spec for you.
- On Windows verify commands never go through a shell: `npm` and `npx` run their JS entry with Node; other `.cmd` / `.bat` files are refused if an argument contains `&`, `|`, `%` or other special characters. Verify commands get neither the worker's secret variables nor AgentRouter's own environment variables.

### What happens when a task fails

A task dispatched from a spec does not fail on its first miss. AgentRouter tries again **in the same working tree**:

1. **Automatic retry**: when the gate fails or the worker exits abnormally, the core hands the failure back to the worker as is: which verify command failed and the tail of its output, which files are out of scope, and which are uncommitted. The worker then carries on. By default it retries up to 2 more times (3 in all). Set `max_retries: N` in the spec, or `maxRetries` in the project config, to change this; `0` means no retry. A worker that never started (missing key, program not found) and a stopped task are not retried.
2. **Escalation**: the first retry normally uses the same worker and reasoning effort; later retries raise the effort, and the last uses the configured strong worker if available. The first retry can also be the last. A profile's `escalate: "<another profile>"` takes precedence. Quota, rate-limit and service failures can switch to another available worker without consuming a retry.
3. **Every attempt is kept**: `.agent-runs/<name>/attempts/<n>/` holds the exact prompt sent (`prompt.md`), the raw output, the report and the gate result. The top-level `report.md` and `gate.json` are the latest. In the app, the list row shows "attempt n/N"; the task details have an attempt switcher for progress, report and gate; and Retry history shows one row per attempt.
4. **Manual retry**: when the automatic retries are used up, or you are not happy with the result, click Retry in the app (you can pick another worker and add a note) or run `ar retry <name> --note "…"`. Retrying a finished task requires a note. A task that is still running cannot be retried; stop it first.
5. **Retries never skip the gate**: the full gate runs every time. `.agent-router/` and the specs folder are protected. A worker that changes them is out of scope unless `allowed_paths` names that folder explicitly. Deleted files are listed separately, so you can check that no tests were removed.
6. **Stopping when the scope is too narrow**: if the worker decides it must change files outside the allowed paths, it lists them in its report under the exact heading `## 需要越界` ("needs scope"). The core then stops retrying and waits for you: widen the scope and retry, change the spec, or give up.
7. **Writes outside the working tree**: before and after each attempt, the core lists the top-level files of the user's home folder and of the shared AgentRouter folder. If a new file appears, the gate fails, there is no automatic retry, and you are asked to check it. Only names and modification times are read; nothing is opened or deleted.

### How tasks are isolated and merged

When the project config `.agent-router/project.json` sets `"worktree": true` (the default in configs created by `ar init`), eligible tasks, including non-read-only text tasks, do not edit your working tree:

1. **Its own worktree and branch**: each task runs in a git worktree outside the project (on Windows, under `%LOCALAPPDATA%\agent-router\wt\` by default), on branch `ar/<name>`, based by default on the project's main branch `baseBranch`; use `--base <branch>` to choose a different base for this dispatch. The worker runs in a separate worktree, so you can keep coding in your main working tree. A worktree is not an operating-system sandbox; access restrictions depend on the agent and its permission settings. Commit the spec to the selected base first, or the worker cannot see it.
2. **Setup commands**: a new worktree has no dependencies. The project's `setup` commands (for example `["npm ci"]`) run one by one after the worktree is created. If one fails, the worker does not start and the worktree is kept for inspection. Fix the command and click Retry to run setup again, or reject the task if you no longer need it.
3. **Parallel runs and the queue**: by default up to 2 tasks run at the same time. Change this under Parallel in Settings or with `concurrency` in `config.json` (1–8, or "auto": estimated from CPU cores and free memory, pausing new starts while the machine is busy). Extra tasks wait in a queue and start on their own. By default one gate runs at a time; `gateConcurrency` can change this.
4. **Awaiting acceptance**: after the gate passes, the task waits for acceptance and its changes stay on its own branch. Review the overview, changes and gate result on the Accept page, then choose one:
   - **Approve and merge** (`ar accept <name>`): creates one merge commit on the selected base branch (`--no-ff`; with `"mergeMode": "squash"` in the project config, a single squashed commit), then removes the worktree and the branch. To undo the whole task, click "撤销这次合并…" (revert this merge) in the task details or run `ar revert <name>` (it only adds a reverting commit). The main working tree must be on the selected base branch and clean; otherwise nothing changes and you are told why.
   - **Reject** (`ar reject <name> --reason "…"`): records why and removes the worktree. You can keep the branch.
   - **Retry**: same as a manual retry after a failure, in the same worktree.
5. **Merge conflicts**: if approving conflicts with newer commits on the selected base branch, the merge is rolled back, that branch is unchanged and the task is marked as a merge conflict. Resolve and retry (`ar retry <name> --rebase`) merges the selected base branch into the worktree: with no conflict the gate runs again; with a conflict the worker resolves it, the gate runs again, and the task comes back for acceptance.
6. **Cleanup**: `ar gc` lists and removes worktrees of merged, rejected or unknown tasks, and stale slot files. The app checks once at start-up and deletes only after you confirm under Cleanup in Settings. Folders created in the last 10 minutes are never treated as leftovers.
7. **Scores**: after a task ends, the Score tab in the task details (`ar report <name>`) gives the worker and the lead a 0–100 score each. Points are deducted per event, and every item is listed. A failed gate can be blamed on the spec, which moves the deduction from the worker to the lead.

To skip the worktree for a single task, dispatch it with `--no-worktree`.

### Adding a new agent, and routing

**Add a new agent in three steps** (Agents page → Import agent):

1. **Pick a type**: a built-in preset (DeepSeek, Xiaomi MiMo, Claude, Codex, Qoder China / international, OpenAI-compatible API), or **Custom CLI** — any command-line agent with a non-interactive mode. Fill in the program, an argument template (placeholders such as `{prompt}`, `{promptFile}`, `{model}`, `{effort}`) and the output format (text, JSONL with event mapping, or Claude Code style). No code needed.
2. **Choose a model and reasoning effort, save the key**: the config stores only the environment variable name; the key itself goes into a Windows user environment variable.
3. **Test**: presets run "Test connection"; a custom CLI runs "Test and preview", with the raw output on the left and the mapped progress on the right. Once it passes you can dispatch work to it. A declaration can be exported and imported elsewhere; the file never contains keys.

The command line does the same (`ar agents add --preset …`, `ar agents import <file>`); every declaration field is described in [`core/adapters/README.md`](core/adapters/README.md).

**Routing**: who gets a task is decided in this order — an explicit choice → the spec's `worker` → project rules → global rules (by task type) → implicit rules (when enabled, for typed tasks except review: research and chore go to the lowest-priced worker in the same currency, other types, and the price step when it finds no one, go by the preset's suggested task types) → the fallback → the default worker. Workers that are disabled, have reached today's limit, or cannot run read-only when the task needs it are skipped. The Routing page lets you order rules, set the fallback and daily limits, and "try" a task type to see who would get it and why; on the command line, `ar route --type test --explain`.

**Read-only research**: tasks of type `research` / `review`, or with `read_only: true`, run read-only and the gate requires no changes at all; on the Accept page you click Confirm, which removes the worktree and branch without merging.

**Network proxy**: Settings → Network proxy offers off / follow the system proxy / manual, applied to dispatched workers and to the lead opened in a project.

**Blame**: a failed gate can be blamed on the worker, the spec, or the environment (for example a timing test failing on an overloaded machine). A gate that failed because the task is behind its selected base branch can be re-run with `ar retry <name> --rebase`: the selected base branch is merged into the task worktree. If there is no conflict, the gate runs again without starting the worker; if there is a conflict, the worker resolves it before the gate runs again.

### Lead, statistics and project target

- **Choosing the lead**: `ar lead set <worker name>` makes an enabled profile that may act as lead and whose adapter supports an interactive launch (`claude-code`, `codex`, or `generic` with an `interactive` declaration) the current lead; `ar lead show` prints it and `ar lead clear` removes it. `ar lead plan --project <path> [--model <model>] [--effort <level>]` works out the launch arguments from the command line, the project, the worker profile and the tool default, in that order; `ar lead open` also records the launch in `leads.jsonl` in the shared folder (launch parameters only, never a session ID or a key). The app can select the lead too: choose it on the lead card on the Agents page and open it from the project page with "Open <name> in this project"; when the program is a batch wrapper, run the `ar lead plan` command in a terminal.
- **Three skills**: `agent-router` (dispatch and acceptance), `lead-workflow` (collaboration mode) and `lead-practices` (lead experience). The installer and Settings install, update, back up and roll back all three; the skill cards in the app and the first-run wizard show their versions and states, and old DispatchDock skills can be backed up and deleted.
- **Statistics**: `ar stats [--range 7d|30d|all] [--project <path>] [--json]` groups by worker, task type and reasoning effort and reports the sample size, pass rate with a Wilson 95% interval, average attempts, gate-failure blame, out-of-scope rate, escalation rate, median duration, average tokens and cost per merged task, and reviewer accuracy; fewer than five samples are marked insufficient. It also has scores by role, a daily trend, groups by lead and an overall view (merges per week, median end-to-end time, human interventions, cost, lead/worker token ratio). The app's Statistics page shows the overall effect, groups by worker, groups by lead, the trend and prices for the selected range, with editable prices per million tokens and immediate recalculation; the reviewer table currently says "no data grouped by reviewer", reviewer accuracy is on the Routing page, and the score summary is available through `ar stats --json`. Cost is reported as unknown when prices or usage are incomplete. Reverted merges and commits fixing the same files within seven days of acceptance are collected only.
- **Project target**: `ar init --target` (or `ar init --upgrade --target` for an existing project) writes `.agent-router/target.md` with the final goal, milestones and done criteria, out of scope, budget and deadline; existing files are never overwritten, and dispatching, the gate and acceptance do not read it.
- **Other v1.0 work**: with `autoCommit` on, AgentRouter commits the changed files before the gate when the worker should have committed but did not; `ar retry --regate` lets a worktree task awaiting acceptance, with a failed gate, or stopped during the gate re-run the gate without restarting the worker; when a task has review enabled and the commit has changed, it is reviewed again after the gate passes; `ar wait --timeout` adds a deadline; `ar status --json` carries report counts; `ar config` sets concurrency keys; and three review constraints can be switched off separately.

### DeepSeek Harness

`ar agents deploy deepseek-harness` first looks for `dsh` on PATH; if it is missing, it installs into AgentRouter's own folder (no global install, no PATH change), imports the preset and tests the connection. `--cleanup` and `undeploy` remove the managed folder. Wizard step 4 and the card on the Agents page can install it too: pick a version, follow the progress and elapsed time, and cancel at any point; an incompatible version shows the reason and offers the verified one, and a failed upgrade falls back to the previous version.

### Development & testing

```powershell
npm run lint:tree        # repository tidiness checks
npm run verify           # type check + all node:test suites
npm run shots            # real-input UI checks with screenshots in app/dist/shots/
npm run shots -- --from stats   # resume from a segment (stats, audit, tail) to the end; only to confirm a fix, not a substitute for the full run
npm run fonts            # fetch the interface fonts from their official sources (not committed)
```

### Acknowledgements & license

Based on [DispatchDock](https://github.com/LBEILC/DispatchDock) by LBEILC (MIT). Notices for fonts and the icon library are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). License: [MIT](LICENSE).
