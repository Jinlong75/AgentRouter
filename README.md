<p align="center"><img src="app/design/icons/app.svg" width="96" alt=""></p>
<h1 align="center">AgentRouter</h1>
<p align="center"><a href="#中文">中文</a> · <a href="#english">English</a></p>

> 状态：开发中（v0.4.0 候选）。本仓库仅包含运行、构建与测试所需的文件。
>
> Status: in development (v0.4.0 candidate). This repository contains only the files needed to run, build and test the project.

## 中文

### 项目介绍

AgentRouter 是一个 Windows 桌面软件加一组 Claude Code 技能：强 Agent（Claude Code）当主导，负责方案、拆解、验收；能写清楚要求的执行工作，路由给便宜或专长的 Agent（DeepSeek、Xiaomi MiMo、Codex 等）。软件是统一调度中心：导入 Agent、添加项目、新建任务派发、查看进度与汇报、停止与再派一次，都能在软件里完成。

本项目基于 [DispatchDock](https://github.com/LBEILC/DispatchDock) v0.1.5（MIT）。

### 功能

| 功能 | 状态 |
|---|---|
| 派发任务（任务说明文件或任务文字），后台运行；进度、统一事件、汇报 | ✅ |
| `ar wait` 等待、`ar stop` 停止整棵进程树；托管（关掉 Claude Code 会话也不中断） | ✅ |
| 统一入口 `ar`：`dispatch · wait · stop · config · init · projects · agents · secrets · spec · retry · version`，`--json` 供软件调用 | ✅ |
| `ar init`：在任意 git 仓库生成项目配置与约定文件（幂等、不覆盖） | ✅ |
| 技能安装器：安装、更新、备份、回退（Claude Code） | ✅ |
| 执行者：DeepSeek、Xiaomi MiMo（经 Claude Code 外壳）、Codex；密钥只记变量名 | ✅ |
| 调度中心：任务页、Agent 页（导入向导、测试连接）、项目页（添加、初始化、提交）、新建任务页、再派一次、批量删除 | ✅ |
| 任务说明规范与机器门禁：执行者结束后，核心自己检查提交、改动范围并逐条运行验收命令；软件显示流水线轨道与门禁结果 | ✅ |
| 自动重试与升级：失败原因交回执行者、同一工作区再试，每次尝试留档；`ar retry` 与软件"重试"、尝试切换与重试历史 | ✅ |
| worktree 并行与验收合并、交叉审查、路由 | 🚧 计划中 |

### 技术栈

| 层 | 技术 |
|---|---|
| 核心引擎 `core/` | Node.js ESM，零第三方依赖，Node ≥ 24；软件里用 Electron 内置 Node 运行 |
| 主导接入 | Claude Code Skills（`SKILL.md`） |
| 执行者 | 经 Claude Code CLI 的模型（`claude-code` 适配器）、Codex CLI；测试与演示用 `fake` |
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
                                                              执行者进程（适配器：claude-code / codex / fake）
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

**技能**：`npm run pack:skills` 打出技能 ZIP，解压后运行 `node installer/install.mjs` 安装到 Claude Code（已有版本先备份，`--rollback` 撤销）。

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
- 只有用任务说明派发、并且有验收命令或限定了允许路径（或类型要求提交）的任务才跑门禁；直接写任务文字派发的任务与以前完全一样。
- 跑门禁的任务派发前要求：任务说明已提交、工作区干净（`.agent-runs/` 除外）。软件新建任务页会自动先提交任务说明。
- Windows 上验收命令不经 shell：`npm`、`npx` 用 Node 直接运行；其他 `.cmd` / `.bat` 的参数里有 `&`、`|`、`%` 等特殊字符时拒绝运行。验收命令拿不到执行者的密钥变量，也拿不到 AgentRouter 自己的环境变量。

### 失败后会发生什么

用任务说明派发的任务，没通过时不会马上算失败，AgentRouter 会在**同一个工作区**再试：

1. **自动重试**：门禁没通过，或执行者异常退出时，核心把失败原因原样交给执行者，包括哪条验收命令失败及其输出末尾、哪些文件越界、哪些没提交，然后让它接着改。默认最多再试 2 次（共 3 次）；任务说明写 `max_retries: N`，或项目配置写 `maxRetries`，可以改，`0` 表示不重试。执行者根本没能启动（缺密钥、找不到程序）或任务被停止时不重试。
2. **换更强的执行者**：执行者配置写 `escalate: "<另一个执行者>"` 时，最后一次自动重试改用它。目标没有启用就不换，进度里会说明。
3. **每次尝试都留档**：`.agent-runs/<名>/attempts/<n>/` 里有这次实际发出的指令 `prompt.md`、原始输出、汇报和门禁结果；任务目录顶层的 `report.md`、`gate.json` 是最近一次的。软件里，列表行显示"尝试 n/N"；任务详情有尝试切换条，可以按次看进展、汇报和门禁；"重试历史"每次一行。
4. **手动重试**：自动重试用完仍失败，或者结果不满意，可以在软件里点"重试"（可以换执行者、写补充说明），或运行 `ar retry <记录名> --note "补充说明"`。已完成的任务重试时必须写补充说明。任务还在进行时不能重试，先停止。
5. **重试不会绕过门禁**：每次都完整跑门禁。`.agent-router/` 与任务说明目录受保护，执行者改它们算越界，除非 `allowed_paths` 明确写了这个目录。删除的文件会单独列出来，方便你检查有没有删测试。

### 开发与测试

```powershell
npm run lint:tree        # 目录整洁检查
npm run verify           # 类型检查 + 全部 node:test
npm run shots            # 真实输入的界面检查并截图到 app/dist/shots/
npm run fonts            # 从官方来源取界面字体（不进仓库）
```

### 致谢与许可证

基于 LBEILC 的 [DispatchDock](https://github.com/LBEILC/DispatchDock)（MIT）。字体与图标库的声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。许可证：[MIT](LICENSE)。

---

## English

### Introduction

AgentRouter is a Windows desktop app plus a set of Claude Code skills. A strong agent (Claude Code) leads: it plans, breaks down work and reviews results, and routes clearly specified execution work to cheaper or specialised agents (DeepSeek, Xiaomi MiMo, Codex and others). The app is the dispatch console: import agents, add projects, dispatch new tasks, follow progress and reports, stop or re-dispatch — all from the app.

Based on [DispatchDock](https://github.com/LBEILC/DispatchDock) v0.1.5 (MIT).

### Features

| Feature | Status |
|---|---|
| Dispatch work (spec file or task text) in the background; progress, unified events and reports | ✅ |
| `ar wait`, `ar stop` for the whole process tree; managed mode (tasks survive closed Claude Code sessions) | ✅ |
| Single entry `ar`: `dispatch · wait · stop · config · init · projects · agents · secrets · spec · retry · version`, `--json` for the app | ✅ |
| `ar init`: project config and conventions for any git repository (idempotent, never overwrites) | ✅ |
| Skill installer: install, update, back up, roll back (Claude Code) | ✅ |
| Workers: DeepSeek, Xiaomi MiMo (through Claude Code), Codex; only key variable names are stored | ✅ |
| Dispatch console: Tasks, Agents (import wizard, connection test), Projects (add, initialise, commit), New Task, re-dispatch, batch delete | ✅ |
| Task specs and machine gates: after the worker exits, the core itself checks commits and changed files and runs each verify command; the app shows a pipeline track and the gate result | ✅ |
| Automatic retry and escalation: failures handed back to the worker, retried in the same tree, every attempt kept; `ar retry` and Retry in the app, attempt switcher and retry history | ✅ |
| Worktree parallelism and accept/merge, cross review, routing | 🚧 Planned |

### Tech stack

| Layer | Technology |
|---|---|
| Core engine `core/` | Node.js ESM, zero third-party dependencies, Node ≥ 24; inside the app it runs on Electron's embedded Node |
| Lead integration | Claude Code Skills (`SKILL.md`) |
| Workers | Models through the Claude Code CLI (`claude-code` adapter), Codex CLI; `fake` for tests and demos |
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
                                                                worker process (adapter: claude-code / codex / fake)
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

**Skills**: `npm run pack:skills` builds the skills ZIP; unzip it and run `node installer/install.mjs` to install into Claude Code (existing versions are backed up first; `--rollback` undoes it).

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
- Only tasks dispatched from a spec that has verify commands or restricted paths (or a type that must commit) run the gate; tasks dispatched as plain text behave exactly as before.
- Gated tasks require a committed spec and a clean working tree (except `.agent-runs/`) at dispatch time. The app's New Task page commits the spec for you.
- On Windows verify commands never go through a shell: `npm` and `npx` run their JS entry with Node; other `.cmd` / `.bat` files are refused if an argument contains `&`, `|`, `%` or other special characters. Verify commands get neither the worker's secret variables nor AgentRouter's own environment variables.

### What happens when a task fails

A task dispatched from a spec does not fail on its first miss. AgentRouter tries again **in the same working tree**:

1. **Automatic retry**: when the gate fails or the worker exits abnormally, the core hands the failure back to the worker as is: which verify command failed and the tail of its output, which files are out of scope, and which are uncommitted. The worker then carries on. By default it retries up to 2 more times (3 in all). Set `max_retries: N` in the spec, or `maxRetries` in the project config, to change this; `0` means no retry. A worker that never started (missing key, program not found) and a stopped task are not retried.
2. **Escalation**: if a worker profile has `escalate: "<another profile>"`, the last automatic retry uses that profile. If the target is not enabled, the worker stays the same and the progress log says so.
3. **Every attempt is kept**: `.agent-runs/<name>/attempts/<n>/` holds the exact prompt sent (`prompt.md`), the raw output, the report and the gate result. The top-level `report.md` and `gate.json` are the latest. In the app, the list row shows "attempt n/N"; the task details have an attempt switcher for progress, report and gate; and Retry history shows one row per attempt.
4. **Manual retry**: when the automatic retries are used up, or you are not happy with the result, click Retry in the app (you can pick another worker and add a note) or run `ar retry <name> --note "…"`. Retrying a finished task requires a note. A task that is still running cannot be retried; stop it first.
5. **Retries never skip the gate**: the full gate runs every time. `.agent-router/` and the specs folder are protected. A worker that changes them is out of scope unless `allowed_paths` names that folder explicitly. Deleted files are listed separately, so you can check that no tests were removed.

### Development & testing

```powershell
npm run lint:tree        # repository tidiness checks
npm run verify           # type check + all node:test suites
npm run shots            # real-input UI checks with screenshots in app/dist/shots/
npm run fonts            # fetch the interface fonts from their official sources (not committed)
```

### Acknowledgements & license

Based on [DispatchDock](https://github.com/LBEILC/DispatchDock) by LBEILC (MIT). Notices for fonts and the icon library are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). License: [MIT](LICENSE).
