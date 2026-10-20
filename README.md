<p align="center"><img src="app/design/icons/app.svg" width="96" alt=""></p>
<h1 align="center">AgentRouter</h1>
<p align="center"><a href="#中文">中文</a> · <a href="#english">English</a></p>

> 状态：开发中（v0.3.0）。本仓库只包含运行、构建与测试所需的文件；设计文档与开发过程文件在开发完成后公开。
>
> Status: in development (v0.3.0). This repository contains only the files needed to run, build and test the project; design documents and development records will be published when development is complete.

## 中文

### 项目介绍

AgentRouter 是一个 Windows 桌面软件加一组 Claude Code 技能：强 Agent（Claude Code）当主导，负责方案、拆解、验收；能写清楚要求的执行工作，路由给便宜或专长的 Agent（DeepSeek、Xiaomi MiMo、Codex 等）。软件是统一调度中心：导入 Agent、添加项目、新建任务派发、查看进度与汇报、停止与再派一次，都能在软件里完成。

本项目基于 [DispatchDock](https://github.com/LBEILC/DispatchDock) v0.1.5（MIT）。

### 功能

| 功能 | 状态 |
|---|---|
| 派发任务（任务说明文件或任务文字），后台运行；进度、统一事件、汇报 | ✅ |
| `ar wait` 等待、`ar stop` 停止整棵进程树；托管（关掉 Claude Code 会话也不中断） | ✅ |
| 统一入口 `ar`：`dispatch · wait · stop · config · init · projects · agents · secrets · spec · version`，`--json` 供软件调用 | ✅ |
| `ar init`：在任意 git 仓库生成项目配置与约定文件（幂等、不覆盖） | ✅ |
| 技能安装器：安装、更新、备份、回退（Claude Code） | ✅ |
| 执行者：DeepSeek、Xiaomi MiMo（经 Claude Code 外壳）、Codex；密钥只记变量名 | ✅ |
| 调度中心：任务页、Agent 页（导入向导、测试连接）、项目页（添加、初始化、提交）、新建任务页、再派一次、批量删除 | ✅ |
| 任务说明规范与机器门禁、自动重试、worktree 并行与验收合并、交叉审查、路由 | 🚧 计划中 |

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
| Single entry `ar`: `dispatch · wait · stop · config · init · projects · agents · secrets · spec · version`, `--json` for the app | ✅ |
| `ar init`: project config and conventions for any git repository (idempotent, never overwrites) | ✅ |
| Skill installer: install, update, back up, roll back (Claude Code) | ✅ |
| Workers: DeepSeek, Xiaomi MiMo (through Claude Code), Codex; only key variable names are stored | ✅ |
| Dispatch console: Tasks, Agents (import wizard, connection test), Projects (add, initialise, commit), New Task, re-dispatch, batch delete | ✅ |
| Task spec format and machine gates, automatic retry, worktree parallelism and accept/merge, cross review, routing | 🚧 Planned |

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

### Development & testing

```powershell
npm run lint:tree        # repository tidiness checks
npm run verify           # type check + all node:test suites
npm run shots            # real-input UI checks with screenshots in app/dist/shots/
npm run fonts            # fetch the interface fonts from their official sources (not committed)
```

### Acknowledgements & license

Based on [DispatchDock](https://github.com/LBEILC/DispatchDock) by LBEILC (MIT). Notices for fonts and the icon library are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). License: [MIT](LICENSE).
