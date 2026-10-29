# 测试资料

- `codex-sample.jsonl`：从只读参考项目任务 002 的原始日志抽取事件结构，包含配置警告、说话、搜索、MCP、文件改动、命令成功/失败和回合结束。所有自然语言、命令、输出、路径、事件 ID 和 token 数均替换为示例值；未保留原始会话 ID、时间戳、账号或主机信息。
- `codex-extra.jsonl`：合成的思考、计划、三种文件改动、顶层错误、回合失败、未知事件及非 JSON 行。参考日志中未找到思考、计划及顶层失败，故明确区分来源。
- `expected-progress.txt`：以旧脚本在隔离 VM 中重放同一份样例的输出为基线，归一化时间和临时汇报路径后，将四处文件路径改为 `/`，得到定稿协议的固定标准答案。样例没有旧版“错误：”事件，且有效配置不产生“配置：”行；这两项另外测试。旧脚本副本已删除。
- `fake-agent.txt`：测试时复制为临时 Node 脚本，回显 argv / stdin、重放样例并写假汇报。生产入口通过 `AR_TEST_AGENT` 注入它，所有公共清单写入临时的 `AGENT_ROUTER_HOME`（旧变量名只在兼容层 `core/lib/compat.mjs` 里出现）。

不在自动验证中调用真实 agent。真实 Codex 验收另用隔离临时仓库、只读沙箱和禁用进度窗口运行。

## 目录一览

其余文件（除上面四个样例外），每个一行：

- `claude-code-sample.jsonl`、`claude-code-extra.jsonl`、`claude-code-multi-result.jsonl`：`claude-code` 适配器的输出样例（常规事件、补充的边缘事件、多个 result 行）。
- `expected-claude-code-events.json`：上面 `claude-code` 样例解析后的标准事件序列。
- `codex-real-sample.jsonl`、`codex-real-error.jsonl`：真实 Codex 输出的匿名化样例（正常回合、出错回合）。
- `expected-codex-real-events.json`：上面两份 Codex 样例解析后的标准事件序列。
- `fake-claude-code.mjs`：假的 Claude Code（经 `AR_TEST_AGENT` 指定），回放样例，不访问任何服务。
- `fake-claude-code-home-probe.mjs`：先往用户目录写探针文件再正常回放，用来确认测试的目录隔离生效。
- `fake-codex-path.mjs`：在临时目录里放一个假的 `codex`，让测试不会在 PATH 里找到真实 Codex。
- `fake-env-names.mjs`：只把自己看到的环境变量名写进指定文件（不写值），用来核对执行者的环境白名单。
- `identity.mjs`：进程身份（pid、创建时间）相关测试共用的断言辅助。
- `visualspec-colors.json`：视觉规范颜色表的机器可读副本，供颜色对比检查使用。
- `generic/`：`generic` 适配器的假命令行执行者与声明（`dsh-cli.mjs`、`jsonl-cli.mjs`、`text-cli.mjs`、`ok-cli.mjs`、`models-cli.mjs`、`jsonl-decl.json`、`qoder-stream.jsonl`）。
- `limits/`：限流识别样例，见 `limits/README.md`。
- `probe/`：`ar agents models --probe` 用的假 `codex`（`fake-codex.mjs` 正常、`fake-codex-fail.mjs` 失败）。
- `review/`：交叉审查测试用的假审查者（`reviewer.mjs`、`reviewer-seq.mjs`）与集成夹具（`pipeline-fixture.mjs`）。
