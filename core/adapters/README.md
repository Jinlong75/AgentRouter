# 执行者适配器

核心（`core/`）只依赖 Node 24 内置模块。分发时复制整个 `core/`，保留 `ar.mjs`、`lib/`、`adapters/`、`templates/` 的相对位置（技能目录里是 `<技能目录>/core/`）。

公共层处理参数、配置、记录名、清单、进度、窗口和生命周期；适配器只处理检测、启动参数及原始事件映射。执行者差异只写在适配器里，公共层不出现 `if (adapter === 'xxx')`。

## 如何接入一个新的 Agent

先判断它属于哪一类，**越靠前越省事**。前三条都不用写代码。

### 1. 模型提供 Anthropic 格式接口：用 Claude Code 外壳

很多模型服务同时提供 Anthropic 格式的接口（DeepSeek、MiMo 等）。

- 软件：Agent 页 → 导入 Agent →"Claude Code 兼容后端"，填接口地址、模型名、密钥环境变量名，测试连接。
- 命令行：`ar agents add --preset compat --name <名> --base-url <地址> --model <模型> --secret-var <变量名>`，再 `ar agents test <名>`。
- 原理：`claude-code` 适配器不绑定模型，执行者配置的 `env` 里设 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`，密钥以 `ANTHROPIC_AUTH_TOKEN` 注入。

### 2. 模型只提供 OpenAI 格式接口：用 Codex 外壳

- 软件：导入 Agent →"OpenAI 兼容接口（经 Codex）"，填接口地址、模型、密钥环境变量名。
- 命令行：`ar agents add --preset openai-compat --name <名> --base-url <地址> --model <模型> --secret-var <变量名>`。
- **限制**（codex-cli 0.163 实测）：Codex 只支持 **Responses** 接口，不再支持 Chat Completions。只提供 Chat Completions 的服务，改用第 1 条（多数国内服务两种都提供）或第 3 条。
- 原理：执行者配置的 `provider` 字段在启动时转成 Codex 的 `-c model_provider=…` 覆盖参数，不读写你自己的 Codex 配置文件。`CODEX_HOME` 与普通 Codex 执行者相同（默认 `~/.codex`）：Windows 上 Codex 的可写沙箱依赖那里配好的提权沙箱，单独的空目录只能只读。

### 3. 只有自家命令行工具：用通用适配器 `generic`

只要这个工具有**非交互模式**（给一段文字、跑完退出），就能填一张表接入。

1. **先确认它的非交互用法**：在一个临时目录里手动试，记下三件事——任务指令怎么传（参数 / 文件 / 标准输入）、输出是什么格式（纯文本 / 每行一个 JSON / Claude Code 风格的 stream-json）、只读用什么参数（没有就不能做调研、审查类任务）。
2. **在软件里填表**：导入 Agent →"自定义 CLI"。程序、检测参数、参数模板（任务指令用 `{prompt}` 或 `{promptFile}` 占位符）、输出格式；JSONL 时填事件映射（例如 `type = message` → 说话，字段 `text ← content`）。点"测试并预览"，左边原始输出、右边映射出的事件，没匹配的行会标出来，改好再保存。
3. **或者写一份声明 JSON**，用命令行导入：

   ```json
   {
     "label": "Example CLI",
     "executable": "example-cli",
     "args": ["run", "--json"],
     "stdin": "{prompt}",
     "output": { "format": "jsonl", "map": [
       { "when": { "type": "message" }, "kind": "say", "text": "content" },
       { "when": { "type": "exec" }, "kind": "cmd", "id": "id", "command": "command", "exit": "exit_code" },
       { "when": { "type": "usage" }, "kind": "turn", "input": "input_tokens", "outputTokens": "output_tokens" }
     ] },
     "report": "lastSay"
   }
   ```

   `ar agents validate <文件>` 先校验（错误带字段路径），通过后加入：`ar agents add --generic "$(cat <文件>)" --name <名>`（在 Git Bash 里运行；Windows PowerShell 5.1 会把带双引号的 JSON 参数拆坏，请改用 Git Bash 或软件里的表单）。也可以手动在 `config.json` 的 `generics` 里放这份声明、执行者配置写 `"adapter": "generic", "generic": "<名>"`（先退出软件）。别人用 `ar agents export` 导出的文件直接 `ar agents import <文件>`；`import` 不收单独的声明。完整字段、占位符与映射规则以校验器 `../lib/generic-schema.mjs` 为准（错误信息会指出哪个字段不对）。
4. **测试**：`ar agents test <名>`（让它只回复 OK：汇报里有 OK 才算通过），再派一个小任务看进展和汇报是否正常。
5. **分享**：`ar agents export <名> --out <文件>` 导出声明，不含密钥值，别人可以直接导入。

练习用的现成例子：`tests/fixtures/generic/jsonl-cli.mjs`（假的 JSONL 命令行工具）与 `tests/fixtures/generic/jsonl-decl.json`（它的声明，`@SCRIPT@` 换成脚本的绝对路径、`executable` 用 `node`）。它不管收到什么都回复"完成"，所以 `ar agents test` 会显示"测试未通过"（没有 OK）；直接派一个任务（`ar dispatch "说一句话" --profile <名> --no-worktree`）看进展里的说话、思考、命令、计划、文件各行。

只读任务（调研、审查）靠 `readOnlyArgs`（换一套参数）和 / 或 `readOnlyEnv`（额外设置的环境变量，如 DeepSeek Harness 的 `DSH_PERMISSION_MODE: "read-only"`）：两者至少写一个才支持只读。`readOnlyEnv` 与 `env` 同样校验（变量名合法、值是字符串、名字不能以 `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD` 结尾，密钥放 `secrets`）；只读运行时先合并 `env`（公共层并入执行者配置），再合并 `readOnlyEnv`（同名覆盖，变量名不分大小写）；非只读运行不用它。

DeepSeek Harness（预设 `deepseek-harness`，程序 `dsh`，用户自己用 npm 安装 `@deepseek-ai/dsh`）也是这样接入的：`dsh headless --json -` 从标准输入读任务，输出 JSONL，映射写在预设的 `output.map` 里；可写任务用 dsh 默认的 `workspace-write`，只读任务设 `DSH_PERMISSION_MODE=read-only`。练习用的假程序是 `tests/fixtures/generic/dsh-cli.mjs`。

Qoder 就是这样接入的（预设 `qoder-cn`、`qoder`，见 `../templates/agents/`）：它的输出是 Claude Code 风格的 stream-json，所以 `output.format` 写 `stream-json`，不用写映射。

**`failureHints[].kind`（额度用完 / 限流时自动换人，Stage07c T7）**：声明里的 `failureHints` 每项是 `{ match, text }`（`match` 是不分大小写的正则，匹配 stderr 与出错事件；`text` 是写进进度的中文说明），可以再加一个可选的 `kind`：

- `"kind": "limit"`：限流 / 额度用完 / 余额不足。命中后这次失败归"环境"（不计重试、不扣分），执行者记下恢复时间（`limits.json`；能从报错里读到"try again in 2 hours"、"try again at 3:15 PM"这类时间就用它，读不到默认 1 小时），派发过程按路由链换下一个可用执行者。
- `"kind": "unavailable"`：服务不可用 / 网络中断。同一执行者**连续两次**都是这类失败才换人，不记恢复时间。
- 不写 `kind`：只是失败提示，行为不变。
- 取值只能是这两个，写别的值校验报错（路径 `generic.failureHints[i].kind`）。通用适配器不套内置的 429 / quota 文字规则，只认声明里写了 `kind` 的提示——它们是别人的程序，输出里的数字可能是任务内容。预设 `qoder`、`qoder-cn`、`deepseek-harness` 各带一条 `limit` 提示（429、rate limit、quota、余额不足）。

### 4. 以上都不行：写专用适配器

需要精细解析（区分命令开始 / 结束、统计 token、读取特殊的登录状态）、或者工具的输出没法用"一行一条规则"描述时，才写专用适配器：照下面"接口"一节实现、在 `index.mjs` 登记，补映射测试（用匿名化的真实事件样例）和真实验收脚本 `tools/verify-real-<适配器>.mjs`。

## 注册表

`index.mjs` 登记可用的适配器，公共层用 `adapterFor(profile, { config })` 按配置里 profile 的 `adapter` 字段取（generic 要用 `config.generics` 解析声明）：

| 适配器 | 文件 | 说明 |
|---|---|---|
| `codex` | `codex.mjs` | Codex CLI（`codex exec --json`） |
| `claude-code` | `claude-code.mjs` | Claude Code CLI（`claude -p --output-format stream-json`）；模型与服务由 profile 的环境变量决定，适配器本身不绑定任何模型 |
| `generic` | `generic.mjs` | 通用适配器（Stage07）：按 `config.generics.<名>` 的声明启动任意命令行 Agent，输出格式 `text` / `jsonl` / `stream-json`；`makeGeneric(decl)` 生成适配器对象 |
| `fake` | `fake.mjs` | 测试与演示：按 profile 回放统一事件、写汇报、按指定退出码结束，不访问任何真实 Agent |

启动器解析（npm `.cmd` 包装 → Node 入口、PATH 查找）在 `../lib/launcher.mjs`，所有适配器共用。

## fake

只用于测试与演示，不访问任何真实 Agent。profile 字段都可选：

| 字段 | 说明 |
|---|---|
| `events` | 回放的统一事件数组，默认一条"假执行者已完成。" |
| `report` | 写进汇报文件的正文，默认 `OK\n` |
| `exit` | 结束时的退出码，默认 0 |
| `delayMs` | 每条事件之间的间隔，默认 0 |
| `version` | `detect` 报出的版本 |
| `releaseFile` | 只用于测试与演示：设置后回放完全部事件先等这个文件出现（短间隔轮询），再写汇报、按 `exit` 结束；用于"软件退出后任务仍在运行"这类检查 |
| `releaseTimeoutMs` | 等 `releaseFile` 的上限（毫秒，正整数，默认 120000）；超时往 stderr 写一行说明、以非 0 退出且不写汇报，不会无限挂着 |
| `writes` | 只用于测试与演示：`[{ path, content }]`，在放行之后、写汇报之前按顺序写入；路径相对项目根、用 `/` 分隔，不接受绝对路径与 `..`，目录不存在时自动创建；默认 `[]` |
| `commit` | 只用于测试与演示：写完文件后的提交信息（非空字符串），只 `git add` / `git commit` `writes` 里的路径（参数数组、不经 shell）；`null`（默认）表示不提交。提交失败时往 stderr 写一行说明、以 1 退出且不写汇报 |
| `attempts` | 只用于测试与演示（Stage05）：按第几次尝试改写回放字段，例如 `{ "1": { "exit": 1 }, "2": { "exit": 0, "report": "第二次\n" } }`；键是 1 起的尝试次数，值只能改上面的回放字段（`events` / `report` / `exit` / `delayMs` / `releaseFile` / `releaseTimeoutMs` / `writes` / `commit`），与基础字段合并后按同一套规则校验；默认 `{}`。用来写"第 1 次门禁失败、第 2 次通过"这类多次尝试的测试。`attempts` 本身不进子进程的回放说明 |

`releaseFile` / `releaseTimeoutMs` / `writes` / `commit` / `attempts` 随执行者快照带给托管与脱离派发的执行者进程（见 `snapshotKeys`）；没有设置时回放说明与之前逐字节一致。

## 接口

| 成员 | 约定 |
|---|---|
| `id` | 清单 `start.adapter` / `start.agent` 中的标识 |
| `label` | 显示名：进度首末行（`=== <显示名> 开始/结束 …`）、只读窗口标题、启动失败文案。profile 的 `label` 优先 |
| `writesReport` | 是否由执行者写 `report`。为 `false` 时公共层把最后一条 `say.text` 原样写入；没有 `say` 时不虚构汇报 |
| `detect({env, settings, profile})` | 返回（或异步返回）`{installed, version}`；取不到版本写 `null`，可携带适配器私有的 `launcher` / `error`。检测只运行版本命令，不发任务 |
| `command({root, report, prompt, settings, detection, env, profile, profileName, attempt, readOnly})` | 返回 `{executable, args, stdin, cleanup?}`（`cleanup` 是任务结束后要删的临时文件，如 generic 的 `{promptFile}`；Stage07 起 `readOnly` 在调研 / 审查类任务时为 `true`），分别为可执行文件、字符串数组、输入文本。公共层固定 `shell:false`；检测结果原样传回此处。`report` 指这次尝试的 `<任务目录>/attempts/<n>/report.md`（顶层 `report.md` 是最新一次的副本）；`attempt` 是这次的尝试次数（1 起），执行者想按次表现不同时用它（见 fake 的 `attempts`） |
| `mapLine(line, {root})` | 一行 stdout 转成零到多个事件数组。事件只含协议规定的 `kind` 及附加字段，`v/seq/at` 由公共层追加。未知 JSON 事件丢弃，非空非 JSON 行转 `text` |
| `createMapper()`（可选） | 返回有状态的 `mapLine`（同一任务内记住命令 id 等）；有它时公共层每个任务新建一个，否则用 `mapLine`。映射函数可带 `lastResult`，交给 `finish` |
| `isolate({home, profileName, profile})`（可选；`profile` 是 Stage07 104 加的） | 返回 `{clear, set, keep}`：`keep` 是白名单之外该执行者还要从基础环境保留的变量名（如 codex 的 `CODEX_HOME`，不得是密钥）；`clear` 是要去掉的变量名或正则；`set` 是追加的变量（如执行者自己的配置目录）。公共层按"原环境取密钥 → 白名单（系统、代理、keep；所有 profile 的密钥来源变量除外）→ 清除 → profile.env → 密钥 → set"的顺序合成环境（`../lib/env.mjs`）。白名单之外的变量一律不传给执行者，需要时写进 profile 的 `env` |
| `snapshotKeys`（可选） | 托管 / 脱离派发时，除公共字段（env、secrets、auth、maxTurns、label、adapter、path）外还要随请求的执行者快照带给执行者进程的 profile 字段名（例如 fake 的回放说明）。没有就只带公共字段 |
| `finalResult(batch)`（可选） | 执行者不自行退出的兜底用：`batch` 是一行 stdout 经 `mapLine` 得到的事件数组；这一行是"最后的结果事件"时返回 `{ ok }`（`ok` 为 `false` 表示结果是错误），否则返回 `null`。没有这个成员就不启用兜底。各适配器的结果事件见下面"执行者不自行退出的兜底" |
| `finish({lastSay, result})`（可选） | 返回写入 `report` 的文本；没有时用最后一条 `say` |
| `capabilities`（可选） | `{readOnly, usage, cost, reportFile}`：能否只读运行、是否报告用量与费用、是否自己写汇报文件 |
| `modelName({profile})`（可选） | 显示用的模型名：`settings.model` 为空时用它写入 `start.model` |
| `loginStatus({env, detection})`（可选） | 订阅登录类执行者的登录状态，供 `ar agents list` 显示；返回 `in` / `out` / `unknown` |
| `failureHint(text, {profile})`（可选） | 执行者非 0 退出时，公共层先把 stderr 末尾几行写成一条 `error` 事件；`text` 是 stderr 加上已有的 `error` 事件文本。适配器认得这类原因时返回一句中文说明（写成第二条 `error`），认不得返回 `null`。说明只引用 profile 里的变量名，不写服务商名 |
| `limitHints`（可选，通用适配器有） | 声明里写了 `kind`（`limit` / `unavailable`）的 `failureHints`；派发流程命中时按限流 / 服务不可用处理，见下面"限流与自动换人" |
| 映射函数的 `rateLimit`（可选，claude-code 有） | Claude Code 的 `rate_limit_event` 不产生统一事件，`createMapper()` 返回的函数把最后一条的 `rate_limit_info` 记在 `rateLimit` 上，派发流程在尝试失败后读它 |

`root`、`report` 是绝对路径。`settings` 包含 `model/effort/tier/sandbox/path/watchWindow`；`profile` 是配置里该执行者的整段设置。模型、强度、档位为 `null` 时不得拼入参数。stdout 会同时存入 `raw.log`，JSON 对象补 `_at`；stderr 原文写入；非 0 退出时末尾几行另作 `error` 事件。后台运行（非交互）且退出码非 0 时，所有 `error` 事件在 `exit=` 行之前逐条打印为"出错：…"，托管时由等待者从事件文件读出后打印。命令退出等待 `close`，确保所有输出读取完毕后才写 `end`。

### 执行者不自行退出的兜底（183，D115）

Claude Code 等执行者有时输出了最后的结果、汇报也写完了，进程却不退出（疑似在等后台任务的通知），任务会一直停在"运行中"。公共层（`../lib/runner.mjs`）的做法：

- **结果事件**：适配器的 `finalResult(batch)` 认出来的那一行输出。`claude-code`：`type: result`（映射为 `turn`；同一行里还有 `error`，即 `is_error` / `error_*` 子类型，结果就是错误）。`codex`：`turn.completed`（映射为 `turn`，总是成功；`turn.failed` / `error` 之后 Codex 会自己退出，不算结果）。`generic`：`output.format` 为 `stream-json` 时同 `claude-code`；`text` / `jsonl` 的声明里还没有"结束条件"，不启用。`fake`：一条 `turn` 事件（总是成功结果）。
- **计时**：看到结果事件后开始计 2 分钟；之后执行者的任何输出（stdout 一行，或 stderr 一段）都重新计时（Claude Code 在后台任务通知后会多开几轮，每轮都有一条 `result`，后一条结果取代前一条）。计时到了，汇报还没有（`writesReport` 的适配器看汇报文件是否存在且非空，其余看 `finish` 能否给出汇报文本）就什么都不做，交给原有的超时 / 停止。
- **进程树里还有子进程在跑就不结束**：执行者把长命令放后台、自己说一句"等通知"结束这一轮时，也会先给出一条结果。所以到时先按身份查执行者的进程树（`../lib/process.mjs` 的 `busyDescendants`，不按进程名认进程），还有正在运行的子孙（`conhost.exe` / `OpenConsole.exe` 这类控制台宿主不算）就不结束，重新计时；进程树里只剩执行者自己才结束。进程查询失败也不结束、重新计时。
- **到时仍不退出**：按身份结束执行者的进程树（`../lib/process.mjs` 的 `killProcessTree`，不按进程名），结束成功后在进度与 `events.jsonl` 里记一条 `text` 事件"执行者没有自行退出：看到结果后 2 分钟仍在运行，已结束它的进程（按结果判定）"（附加字段 `noExit: true`、`result: "success" | "error"`）。
- **判定**：按最后一个结果事件——成功结果按退出码 0（走门禁），错误结果按退出码 1（原来的失败处理）。不计重试、不扣分，不算中断。
- 2 分钟可缩短：测试设环境变量 `AR_TEST_NO_EXIT_GRACE_MS`（毫秒），或 `runOnce` 的 `noExitGraceMs` 参数。

### 限流与自动换人（Stage07c T7）

执行者非 0 退出后，派发流程（`../lib/pipeline.mjs`）先用 `../lib/limits-state.mjs` 的 `classifyFailure` 判断是不是"环境"原因，规则如下（只看出错事件、stderr，不看执行者的普通说话和命令输出，免得任务内容里的 429 误判）：

| 适配器 | 识别 |
|---|---|
| `claude-code` | `rate_limit_event` 的 `status` 不是 `allowed` / `allowed_warning`（最后一条为准），恢复时间取 `resetsAt`（unix 秒）；另认出错文字里的 429 / rate limit / too many requests、402 / insufficient / quota / balance、余额 / 额度不足 |
| `codex` | 出错事件 / stderr 里的 `usage limit`（`You’ve hit your usage limit. … try again at 3:15 PM.`）、`Quota exceeded`、`rate limit exceeded`、429；原文出处 Codex 源码 `codex-rs/protocol/src/error.rs`（`UsageLimitReachedError` 等的 Display，时间由 `format_retry_timestamp` 写成当天 `3:15 PM` 或 `Jan 5th, 2026 3:05 PM`） |
| `generic` | 只认声明里写了 `kind` 的 `failureHints`（见上） |
| 所有适配器（除 `generic`） | 网络 / 服务不可用：ENOTFOUND、ECONNRESET、ETIMEDOUT、ECONNREFUSED、EAI_AGAIN、fetch failed，报错里带状态码字样的 5xx、service unavailable、overloaded、at capacity |

限流（`limit`）：归因"环境"（`marks.json`）、记恢复时间（`<公共目录>/limits.json`，路由到恢复前跳过它）、立刻换下一个可用执行者，这次不计重试；服务不可用（`unavailable`）要同一执行者连续两次才换，不记恢复时间。换人最多 5 次；命令行 / 任务说明明确指定了执行者、手动重试、直接写任务文字派发（没有路由记录）的任务不换人。

统一事件的格式以核心实现（`core/lib/` 与本目录各适配器的 `mapLine`）为准。`say/think` 保留完整换行；命令 `start/end` 用同一个 `id`；命令结果按前 200 行且最多 16384 字节截断；文件路径相对 `root`，使用 `/` 分隔。`progress.log` 只调用公共 `formatProgress`，不能再解析原始事件。

## 最小模板

以下仅演示接口，不是已接入的执行者。接入时在 `index.mjs` 登记，并补映射测试与真实验收脚本 `tools/verify-real-<适配器>.mjs`。

```js
import { spawnSync } from 'node:child_process';

export function makeAdapter(executable) {
  return {
    id: 'example',
    label: 'Example',
    writesReport: false,
    detect({ env }) {
      const r = spawnSync(executable, ['--version'], {
        env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
      });
      return { installed: r.status === 0, version: r.status === 0 ? r.stdout.trim() : null };
    },
    command({ prompt }) {
      return { executable, args: ['--stdin'], stdin: prompt };
    },
    mapLine(line) {
      // 根据目标工具实际输出协议替换此处；文本会成为最终汇报。
      return line.trim() ? [{ kind: 'say', text: line }] : [];
    },
  };
}
```

## 公共行为与 Codex 配置

- profile 选择：派发时由路由器选（任务说明 `worker` → 项目规则 → 全局规则 → 兜底 → 默认执行者，见 `core/lib/router.mjs`）；`--profile` 直接指定则不经路由。路由没有结果时才按 `AR_PROFILE` > `config.json` 的 `defaultProfile` > 唯一启用的 profile 兜底；都没有时报"还没有可用的执行者"。没有配置文件时内置一个 `codex` profile。
- Codex：`profiles.codex.path` 有值时直接使用，不查 PATH；Node 入口（`.js` / `.mjs` / `.cjs`）用 `process.execPath`，可执行文件直接启动，`.cmd` / `.bat` 按 npm 包装解析；文件不存在或包装不支持则报错。未设置时在 PATH 中查找 `codex.exe` 或 npm `codex.cmd`。不经过 shell，因此空格和中文参数不会被拆开。
- 参数优先级：命令行 > 环境变量（`CODEX_MODEL` / `CODEX_EFFORT` / `CODEX_TIER` / `CODEX_SANDBOX`，只作用于 codex 执行者）> 任务说明（仅模型、推理强度）> 命中的路由规则（仅推理强度）> `config.json` 里该执行者的设置 > 内置默认，见 `core/lib/config.mjs` 的 `resolveSettings`。模型、强度、档位默认 `null`，沙箱默认 `workspace-write`，窗口默认 `auto`。
- 公共目录 `AGENT_ROUTER_HOME`、预演 `AR_DRY_RUN`、关窗口 `AR_NO_WATCH`、测试执行者 `AR_TEST_AGENT`；旧变量名仍有效，兼容规则集中在 `../lib/compat.mjs`。
- 预演时只打印去重后的记录名和任务指令，不读配置、不检测执行者、不创建目录或文件。`AR_TEST_AGENT` 仅供测试，指定一个 Node 脚本代替 Codex 入口；自动测试使用临时目录和假进程，`npm run verify` 不访问真实 Agent。
- `auto` 在非交互 Windows 环境且监控软件未接管时打开只读窗口；`always` 忽略接管；`never` 禁止弹窗。
- 占好记录名后立即打印"记录名："和"进度："两行。配置提示紧跟进度首行，并打印到标准输出。所有错误前缀统一为"出错："。
- `ar config` 查看默认值与来源，`ar config 键=值` 修改，值 `-` 写入 null；`ar config init` 只在配置不存在时创建。配置写入保留未知字段，先写临时文件再改名。
- 在目标仓库运行 `node "<技能目录>/core/ar.mjs" wait [记录名]`，只读等待已有任务并返回原退出码；省略记录名时取当前仓库最近开始的任务（新旧两份清单都查）。

## claude-code

- 启动：`profiles.<名>.path` 有值时直接用，否则在 PATH 中找 `claude.exe` 或 npm `claude.cmd`；npm 包装指向原生 `claude.exe` 时直接启动该 exe（【核实】Claude Code 2.1.302 的 npm 包是原生程序）。
- 写入模式：`-p --output-format stream-json --verbose --permission-mode bypassPermissions`，任务指令从标准输入传入。只读模式：`--permission-mode dontAsk --tools Read,Grep,Glob,WebSearch,WebFetch --allowedTools` 同一白名单。profile 的 `maxTurns` 拼成 `--max-turns`。`model` / `effort`（命令行 > profile，见协议第 4 节）不为 `null` 时两种模式都依次追加 `--model <值>`、`--effort <值>`，值原样传入、不校验；为 `null` 时不拼。`tier` 不传入任何参数，派发时进度里写一行"配置：claude-code 执行者不支持 tier，已忽略"。
- 隔离：`CLAUDE_CONFIG_DIR` 指向 `<公共目录>/workers/<profile>/claude`，读不到用户本人的登录、设置与个人技能；设 `DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。子进程环境是白名单（见接口表 `isolate`），另按前缀清掉 `ANTHROPIC_*`、`CLAUDE_*`、`CLAUDECODE`（主导会话会传下自己的会话变量），再放入 profile 的 `env` 与密钥。
- 认证：profile 的 `auth` 为 `token` 时，`secrets` 里的变量（如 `ANTHROPIC_AUTH_TOKEN`）从用户环境变量读出值后放入子进程环境，值不进命令行、日志或文件；为 `login` 时用执行者配置目录里的订阅登录。
- 映射：`system/init` → 模型；`assistant` 的文字 / 思考 / 工具调用与 `user` 的工具结果 → `say` / `think` / `cmd` / `file` / `plan` / `tool`；`result` → `turn` 用量与最终汇报（`finish` 优先用它）。其余 `system` 事件丢弃。执行者把验证放后台时，后台通知会让 Claude Code 多开几轮、每轮一条 `result`，此时取文字最长的一条作汇报（一样长取靠后的），免得真正的汇报被后面的"等通知"之类短回复覆盖；只有一条时就是它。
- 预设：`../templates/agents/*.json`（`ar agents presets` 查看），按 `order` 排列：`deepseek`（1，推荐）、`mimo`（2）、`mimo-payg`（3）、`claude-native`（4）、`claude-subscription`（5）、`compat`（6）、`codex`（7）、`qoder-cn` / `qoder`（8，通用适配器）、`deepseek-harness`（8.5，通用适配器，用户自己安装 dsh）、`openai-compat`（9，Codex 外壳）。预设里的 `modelOptions`、`effortOptions`、`baseUrlOptions`、`listModels` 是预设与探测用的元数据，不写进 `config.json`：软件的下拉框和 `ar agents models` 用它们（`listModels` 是列出模型用的命令行参数，缺省或失败时退回 `modelOptions`）；`effortOptions` 还用于校验任务说明 / 路由规则给出的推理强度（命令行明确给的强度不校验），自动重试升档也按它的顺序。
- 预设的 `card` 与 `variant` 也只给导入向导用（`ar agents presets --json` 原样输出，`ar agents add` 不写进 `config.json`）：`card`（`id`、`title`、`description`）把同一服务的几个预设合成向导第 1 步的一张卡片，`variant`（`label`、`option`、`help`）是第 2 步分段按钮里这个预设对应的选项与说明。目前合并的有 Claude Code（`claude-native` / `claude-subscription`）、Xiaomi MiMo（`mimo` / `mimo-payg`）、Qoder（`qoder-cn` / `qoder`）。同一 `card.id` 的预设必须有相同的 `card` 和相同的 `variant.label`、不同的 `variant.option`，否则 `ar agents presets` 报"预设模板错误"。预设本身（名字、地址、密钥变量）不受合并影响。预设模板是代码里唯一写具体服务商与模型名的地方。
- MiMo 有两种接入，密钥类型与接口地址不能混用：Token Plan（个人 / 团队，API Key 以 `tp-` / `ttp-` 开头）用 `mimo` 预设，地址 `https://token-plan-cn.xiaomimimo.com/anthropic`；按量付费（API Key 以 `sk-` 开头）用 `mimo-payg` 预设，地址 `https://api.xiaomimimo.com/anthropic`。两者都用 `ANTHROPIC_AUTH_TOKEN` 认证，密钥来源环境变量是 `MIMO_API_KEY`，默认模型 `mimo-v2.6-pro`。
- 导入 Agent 向导的第 2 步，或 Agent 页执行者的"编辑"，都可以改接口地址与模型；`ar agents add` / `update` 也可以用 `--base-url`、`--model`。

手动真实验收：`node tools/verify-real-claude-code.mjs [--preset <预设>]`（默认 deepseek，会产生少量费用）。

Codex 手动真实验收：在仓库根目录运行 `node tools/verify-real-codex.mjs ok`。该命令会使用现有 Codex 登录状态，在临时中文和空格路径下新建 git 仓库，仅派发"只回复 OK，不改任何文件"，并保留临时证据供检查。不会改动真实安装、配置或清单。
