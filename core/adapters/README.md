# 执行者适配器

核心（`core/`）只依赖 Node 24 内置模块。分发时复制整个 `core/`，保留 `ar.mjs`、`lib/`、`adapters/`、`templates/` 的相对位置（技能目录里是 `<技能目录>/core/`）。

公共层处理参数、配置、记录名、清单、进度、窗口和生命周期；适配器只处理检测、启动参数及原始事件映射。执行者差异只写在适配器里，公共层不出现 `if (adapter === 'xxx')`。

## 注册表

`index.mjs` 登记可用的适配器，公共层用 `adapterFor(profile)` 按配置里 profile 的 `adapter` 字段取：

| 适配器 | 文件 | 说明 |
|---|---|---|
| `codex` | `codex.mjs` | Codex CLI（`codex exec --json`） |
| `claude-code` | `claude-code.mjs` | Claude Code CLI（`claude -p --output-format stream-json`）；模型与服务由 profile 的环境变量决定，适配器本身不绑定任何模型 |
| `fake` | `fake.mjs` | 测试与演示：按 profile 回放统一事件、写汇报、按指定退出码结束，不访问任何真实 Agent |

Stage07 加 `generic`。启动器解析（npm `.cmd` 包装 → Node 入口、PATH 查找）在 `../lib/launcher.mjs`，所有适配器共用。

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

`releaseFile` / `releaseTimeoutMs` 随执行者快照带给托管与脱离派发的执行者进程（见 `snapshotKeys`）；没有设置 `releaseFile` 时行为与之前一致。

## 接口

| 成员 | 约定 |
|---|---|
| `id` | 清单 `start.adapter` / `start.agent` 中的标识 |
| `label` | 显示名：进度首末行（`=== <显示名> 开始/结束 …`）、只读窗口标题、启动失败文案。profile 的 `label` 优先 |
| `writesReport` | 是否由执行者写 `report`。为 `false` 时公共层把最后一条 `say.text` 原样写入；没有 `say` 时不虚构汇报 |
| `detect({env, settings, profile})` | 返回（或异步返回）`{installed, version}`；取不到版本写 `null`，可携带适配器私有的 `launcher` / `error`。检测只运行版本命令，不发任务 |
| `command({root, report, prompt, settings, detection, env, profile})` | 返回 `{executable, args, stdin}`，分别为可执行文件、字符串数组、输入文本。公共层固定 `shell:false`；检测结果原样传回此处 |
| `mapLine(line, {root})` | 一行 stdout 转成零到多个事件数组。事件只含协议规定的 `kind` 及附加字段，`v/seq/at` 由公共层追加。未知 JSON 事件丢弃，非空非 JSON 行转 `text` |
| `createMapper()`（可选） | 返回有状态的 `mapLine`（同一任务内记住命令 id 等）；有它时公共层每个任务新建一个，否则用 `mapLine`。映射函数可带 `lastResult`，交给 `finish` |
| `isolate({home, profileName})`（可选） | 返回 `{clear, set, keep}`：`keep` 是白名单之外该执行者还要从基础环境保留的变量名（如 codex 的 `CODEX_HOME`，不得是密钥）；`clear` 是要去掉的变量名或正则；`set` 是追加的变量（如执行者自己的配置目录）。公共层按"原环境取密钥 → 白名单（系统、代理、keep；所有 profile 的密钥来源变量除外）→ 清除 → profile.env → 密钥 → set"的顺序合成环境（`../lib/env.mjs`）。白名单之外的变量一律不传给执行者，需要时写进 profile 的 `env` |
| `snapshotKeys`（可选） | 托管 / 脱离派发时，除公共字段（env、secrets、auth、maxTurns、label、adapter、path）外还要随请求的执行者快照带给执行者进程的 profile 字段名（例如 fake 的回放说明）。没有就只带公共字段 |
| `finish({lastSay, result})`（可选） | 返回写入 `report` 的文本；没有时用最后一条 `say` |
| `capabilities`（可选） | `{readOnly, usage, cost, reportFile}`：能否只读运行、是否报告用量与费用、是否自己写汇报文件 |
| `modelName({profile})`（可选） | 显示用的模型名：`settings.model` 为空时用它写入 `start.model` |
| `loginStatus({env, detection})`（可选） | 订阅登录类执行者的登录状态，供 `ar agents list` 显示；返回 `in` / `out` / `unknown` |
| `failureHint(text, {profile})`（可选） | 执行者非 0 退出时，公共层先把 stderr 末尾几行写成一条 `error` 事件；`text` 是 stderr 加上已有的 `error` 事件文本。适配器认得这类原因时返回一句中文说明（写成第二条 `error`），认不得返回 `null`。说明只引用 profile 里的变量名，不写服务商名 |

`root`、`report` 是绝对路径。`settings` 包含 `model/effort/tier/sandbox/path/watchWindow`；`profile` 是配置里该执行者的整段设置。模型、强度、档位为 `null` 时不得拼入参数。stdout 会同时存入 `raw.log`，JSON 对象补 `_at`；stderr 原文写入；非 0 退出时末尾几行另作 `error` 事件。后台运行（非交互）且退出码非 0 时，所有 `error` 事件在 `exit=` 行之前逐条打印为"出错：…"，托管时由等待者从事件文件读出后打印。命令退出等待 `close`，确保所有输出读取完毕后才写 `end`。

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

- profile 选择：`--profile` > 环境变量 `AR_PROFILE` > `config.json` 的 `defaultProfile` > 唯一启用的 profile；都没有时报"还没有可用的执行者"。没有配置文件时内置一个 `codex` profile。
- Codex：`profiles.codex.path` 有值时直接使用，不查 PATH；Node 入口（`.js` / `.mjs` / `.cjs`）用 `process.execPath`，可执行文件直接启动，`.cmd` / `.bat` 按 npm 包装解析；文件不存在或包装不支持则报错。未设置时在 PATH 中查找 `codex.exe` 或 npm `codex.cmd`。不经过 shell，因此空格和中文参数不会被拆开。
- 参数优先级：命令行 > 环境变量（`CODEX_MODEL` / `CODEX_EFFORT` / `CODEX_TIER` / `CODEX_SANDBOX`，只作用于 codex 执行者）> `config.json` > 内置默认。模型、强度、档位默认 `null`，沙箱默认 `workspace-write`，窗口默认 `auto`。
- 公共目录 `AGENT_ROUTER_HOME`、预演 `AR_DRY_RUN`、关窗口 `AR_NO_WATCH`、测试执行者 `AR_TEST_AGENT`；旧变量名仍有效，兼容规则集中在 `../lib/compat.mjs`。
- 预演时只打印去重后的记录名和任务指令，不读配置、不检测执行者、不创建目录或文件。`AR_TEST_AGENT` 仅供测试，指定一个 Node 脚本代替 Codex 入口；自动测试使用临时目录和假进程，`npm run verify` 不访问真实 Agent。
- `auto` 在非交互 Windows 环境且监控软件未接管时打开只读窗口；`always` 忽略接管；`never` 禁止弹窗。
- 占好记录名后立即打印"记录名："和"进度："两行。配置提示紧跟进度首行，并打印到标准输出。所有错误前缀统一为"出错："。
- `ar config` 查看默认值与来源，`ar config 键=值` 修改，值 `-` 写入 null；`ar config init` 只在配置不存在时创建。配置写入保留未知字段，先写临时文件再改名。
- 在目标仓库运行 `node "<技能目录>/core/ar.mjs" wait [记录名]`，只读等待已有任务并返回原退出码；省略记录名时取当前仓库最近开始的任务（新旧两份清单都查）。

## claude-code

- 启动：`profiles.<名>.path` 有值时直接用，否则在 PATH 中找 `claude.exe` 或 npm `claude.cmd`；npm 包装指向原生 `claude.exe` 时直接启动该 exe（【核实】Claude Code 2.1.302 的 npm 包是原生程序）。
- 写入模式：`-p --output-format stream-json --verbose --permission-mode bypassPermissions`，任务指令从标准输入传入。只读模式：`--permission-mode dontAsk --tools Read,Grep,Glob,WebSearch,WebFetch --allowedTools` 同一白名单。profile 的 `maxTurns` 拼成 `--max-turns`。
- 隔离：`CLAUDE_CONFIG_DIR` 指向 `<公共目录>/workers/<profile>/claude`，读不到用户本人的登录、设置与个人技能；设 `DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。子进程环境是白名单（见接口表 `isolate`），另按前缀清掉 `ANTHROPIC_*`、`CLAUDE_*`、`CLAUDECODE`（主导会话会传下自己的会话变量），再放入 profile 的 `env` 与密钥。
- 认证：profile 的 `auth` 为 `token` 时，`secrets` 里的变量（如 `ANTHROPIC_AUTH_TOKEN`）从用户环境变量读出值后放入子进程环境，值不进命令行、日志或文件；为 `login` 时用执行者配置目录里的订阅登录。
- 映射：`system/init` → 模型；`assistant` 的文字 / 思考 / 工具调用与 `user` 的工具结果 → `say` / `think` / `cmd` / `file` / `plan` / `tool`；`result` → `turn` 用量与最终汇报（`finish` 优先用它）。其余 `system` 事件丢弃。
- 预设：`../templates/agents/*.json`（`ar agents presets` 查看），按 `order` 排列：`deepseek`（1，推荐）、`mimo`（2）、`mimo-payg`（3）、`claude-native`（4）、`claude-subscription`（5）、`compat`（6）、`codex`（7）。预设模板是代码里唯一写具体服务商与模型名的地方。
- MiMo 有两种接入，密钥类型与接口地址不能混用：Token Plan（个人 / 团队，API Key 以 `tp-` / `ttp-` 开头）用 `mimo` 预设，地址 `https://token-plan-cn.xiaomimimo.com/anthropic`；按量付费（API Key 以 `sk-` 开头）用 `mimo-payg` 预设，地址 `https://api.xiaomimimo.com/anthropic`。两者都用 `ANTHROPIC_AUTH_TOKEN` 认证，密钥来源环境变量是 `MIMO_API_KEY`，默认模型 `mimo-v2.6-pro`。
- 导入 Agent 向导的第 2 步，或 Agent 页执行者的"编辑"，都可以改接口地址与模型；`ar agents add` / `update` 也可以用 `--base-url`、`--model`。

手动真实验收：`node tools/verify-real-claude-code.mjs [--preset <预设>]`（默认 deepseek，会产生少量费用）。

Codex 手动真实验收：在仓库根目录运行 `node tools/verify-real-codex.mjs`。该命令会使用现有 Codex 登录状态，在临时中文和空格路径下新建 git 仓库，仅派发"只回复 OK，不改任何文件"，并保留临时证据供检查。不会改动真实安装、配置或清单。
