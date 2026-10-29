# 限流识别的样例（任务 148）

识别规则在 `core/lib/limits-state.mjs`，样例按适配器分：

- `fake-limit-agent.mjs`：假执行者（`AR_TEST_AGENT`），按环境变量 `AR_LIMIT_MODE` 输出 Claude Code 的 `rate_limit_event` 样例或回放 Codex 的限流输出。
- `codex-usage-limit.jsonl`：Codex 限流时的输出。文字原样取自 Codex 的源码 `codex-rs/protocol/src/error.rs`（`UsageLimitReachedError` 的 Display：`You’ve hit your usage limit. … or try again at {时间}.`；时间由 `format_retry_timestamp` 写成当天的 `3:15 PM`，不是当天的写成 `Jan 5th, 2026 3:05 PM`），出处：<https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs>。

文字里的时间、URL 是示例，不含账号、会话或密钥。
