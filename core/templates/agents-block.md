## AgentRouter 协作

本项目用 AgentRouter 分工：主导（强模型）写方案与任务说明、验收；执行者（便宜或专长的 Agent）按任务说明实现；审查者只读审查。

交互会话里的你默认是主导；由 AgentRouter 派发启动、指令开头写明角色的才是执行者或审查者。

- 指令开头写明了角色时，读对应的角色文档：主导 `docs/roles/lead.md`，执行者 `docs/roles/worker.md`，审查者 `docs/roles/reviewer.md`。不要因为自己是哪个模型就推断角色。
- 任务说明放在 `docs/specs/`，按 `NNN-简述.md` 编号；索引与写法见 `docs/specs/README.md`。
- 项目配置在 `.agent-router/project.json`（主分支、准备命令、验收命令、允许改动的路径）。
- 只做任务说明范围内的事；需要判断的地方留 `TODO(lead)` 并写进汇报。
- 只 `git add` 具体文件；任务记录目录 `.agent-runs/` 不进 git。
