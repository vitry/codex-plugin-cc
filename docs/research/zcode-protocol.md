# ZCode 插件与 Protocol 研究

> 研究日期：2026-07-26
> 本机产品：ZCode Desktop 3.3.6 (build 3.3.6.3198)
> 内置 CLI：`zcode 0.15.2`
> 研究范围：只使用本机 ZCode 安装包、内置插件、CLI 输出和 stdio 协议探测。未使用网络或第三方资料。

## 1. 证据与复现方法

主要一手来源：

- CLI bundle：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
  - bundle 元数据：`/Applications/ZCode.app/Contents/Resources/glm/.node-bundle-meta.json`
  - 元数据给出的原始构建入口为 `apps/zcode-cli/packages/cli/dist/zcode.cjs`
  - 本次研究时 SHA-256：`a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239`
- 内置插件：`/Applications/ZCode.app/Contents/Resources/glm/packages/`
- 配置指南：
  - `.../zcode-guide-plugin/skills/zcode-configuration-guide/SKILL.md`
  - `.../zcode-guide-plugin/skills/diagnosing-{plugins,commands,skills,hooks,mcp}/SKILL.md`
- 插件实例：
  - `.../android-emulator-plugin/.zcode-plugin/plugin.json`
  - `.../android-emulator-plugin/.mcp.json`
  - `.../ios-simulator-plugin/.zcode-plugin/plugin.json`
- Desktop 元数据：`/Applications/ZCode.app/Contents/Info.plist`

关键复现命令：

```sh
ZCODE=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs

$ZCODE --help
$ZCODE version
$ZCODE doctor --json
$ZCODE plugins list --json
$ZCODE commands list --json
$ZCODE skills list --json

printf '%s\n' \
  '{"id":1,"method":"session/list","params":{}}' \
  '{"id":2,"method":"bogus","params":{}}' |
  $ZCODE app-server
```

限制：

- bundle 已压缩，以下源码位置以“文件 + 可搜索符号/字符串 + 近似字节偏移”标识，而不是不稳定的行号。
- 没有启用、禁用或安装测试插件，以免改变用户配置；安装/启用写路径由 bundle、内置指南和现有缓存布局交叉确认。
- 本机没有带非空 hooks/agents 的内置插件，因此这些组件的解析与启动路径可由源码确认，但未做真实插件端到端执行。
- 实际检出分支为 `main`；本地 `zcode-adapter` 和 `origin/zcode-adapter` 当时与当前提交相同（`4cb258a`）。

## 2. 总结

1. ZCode 插件是一个带 manifest 的目录。首选 manifest 为 `.zcode-plugin/plugin.json`，其次兼容 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`。
2. 插件身份是 `<manifest.name>@<marketplace>`。manifest 最少只要求合法 `name`；缺失 `version` 时内部默认 `0.0.0`。
3. 当前 runtime 确认会解析并接入 commands、skills、hooks、MCP，以及 plugin agent profile。`channels`、`lspServers`、`outputStyles`、`settings` 只诊断，不执行。
4. ZCode Protocol 是无显式 `initialize` 握手的双向 NDJSON RPC。每行一个 JSON；请求、通知、结果、错误都不带 `jsonrpc` 字段。
5. Protocol 主请求面包括 session、workspace/model、MCP、plugins、prompt enhance、usage；服务端还会反向请求客户端处理 permission、user input、provider runtime headers。
6. 当 ZCode 是宿主、Codex 是外部执行引擎时，宿主能力不会凭空暴露给 Codex。可见信息只来自：
   - ZCode 注入的模型上下文和工具；
   - Protocol 的 session snapshot/event 和反向交互请求；
   - 插件 MCP/hook/command 子进程的显式环境变量；
   - 插件自己能通过文件工具读取的工作区文件。
7. 没有证据表明插件可直接读取 ZCode UI 状态、任意会话数据库、凭据、插件总表或宿主进程内对象。需要这些能力时必须经过现有 Protocol 方法、模型工具或插件自行提供的 MCP。

## 3. 插件 manifest、目录和变量

### 3.1 Manifest 定位与身份

bundle 的 `e3o`/`Ext` 查找顺序（约 byte 8,808,414 和 8,842,000）：

1. `.zcode-plugin/plugin.json`
2. `.claude-plugin/plugin.json`
3. `.codex-plugin/plugin.json`

`name` 必须匹配：

```regex
^[a-z0-9][a-z0-9._-]{0,127}$
```

插件 id 为 `<name>@<marketplace>`。可选基础字段包括：

- `version`，默认 `0.0.0`
- `description`
- `author`
- `license`
- `commands`
- `skills`
- `hooks`
- `mcpServers`
- `agents`
- `userConfig`

组件路径必须留在插件根目录内；绝对路径或 `..` 逃逸会产生 `plugin_component_path_invalid`，该组件不加载。证据：bundle `a7r`/`Zd`（约 byte 8,841,170）。

### 3.2 组件目录和声明形态

当插件根目录存在同名默认目录时，ZCode 会自动发现：

```text
plugin-root/
  .zcode-plugin/plugin.json
  commands/*.md
  skills/*/SKILL.md
  hooks/hooks.json
  agents/*.md
  .mcp.json
```

`commands`、`skills`、`agents` 可声明字符串目录、字符串数组，或在部分场景使用 inline object。组件枚举证据为 bundle `bfe`/`cBr`/`dTo`/`dBr`（约 byte 8,742,619）。

内置 Android manifest 是完整实例：

```json
{
  "name": "android-emulator",
  "version": "0.1.0",
  "skills": "skills",
  "commands": "commands",
  "mcpServers": {
    "android-emulator": {
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "ANDROID_PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "ANDROID_PLUGIN_API_LEVEL": "${user_config.api_level}"
      }
    }
  }
}
```

来源：`.../android-emulator-plugin/.zcode-plugin/plugin.json`。

### 3.3 `userConfig`

字段定义支持：

- `type`: `string | number | boolean | directory | file`
- `title`
- `description`
- `default`
- `required`
- `sensitive`

值保存在 `plugins.options.<plugin-id>`。`${user_config.key}` 先取用户配置，再取 manifest 的 `default`。

敏感值限制：

- 当前 UI/配置文件没有安全凭据存储，`sensitive: true` 的值不能通过界面录入或持久化。
- MCP 中敏感值只允许用于 `env` 或 `headers`，不能用于 `command`、`args`、`cwd`、`url`。

证据：`diagnosing-plugins/SKILL.md` 第 2 节；bundle `qd`（约 byte 8,736,687）。

### 3.4 模板变量

#### Skill 内容

加载 skill 时替换：

- `${CLAUDE_SKILL_DIR}`
- `${ZCODE_SKILL_DIR}`

替换值是 skill 的真实 base directory。证据：bundle `_gn`/`skillHandler`（约 byte 1,017,217）。

#### Plugin MCP

启动前可展开：

- `${CLAUDE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_ROOT}`
- `${CLAUDE_PLUGIN_DATA}` / `${ZCODE_PLUGIN_DATA}`
- `${CLAUDE_PROJECT_DIR}` / `${ZCODE_PROJECT_DIR}`
- `${user_config.<key>}`
- 名称以 `ZCODE_` 开头的宿主环境变量

MCP 在 session runtime 建立前解析，因此下列变量会报“requires a runtime session context”：

- `${CLAUDE_CODE_SESSION_ID}`
- `${CLAUDE_SESSION_ID}`
- `${ZCODE_SESSION_ID}`

Skill 目录变量在 MCP 中也不可用。证据：bundle `qd`。

MCP server 进程不会自动收到所有宿主字段；它只收到 manifest `env` 中解析后的项，加上该进程本来继承的环境。内置插件明确把 root/data/project/user config 映射到自己的环境变量。

#### Hooks

hook command/args 会展开并注入：

- `CLAUDE_CODE_SESSION_ID`
- `CLAUDE_SESSION_ID` / `ZCODE_SESSION_ID`
- `CLAUDE_PROJECT_DIR` / `ZCODE_PROJECT_DIR`
- plugin hook 另有 `CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT`
- plugin hook 另有 `CLAUDE_PLUGIN_DATA` / `ZCODE_PLUGIN_DATA`

hook 进程环境还包含 `ZCODE_PLUGIN_ID`、`ZCODE_PLUGIN_NAME`。`${*_SKILL_DIR}` 在 hook 中是错误。证据：bundle `uRt`/`sIe`（约 byte 1,073,658）。

#### Plugin command 的 shell expansion

bundle 的 `DMo` 会给 shell expansion 注入 project、session、plugin root/data/id/name；但当前内置 `diagnosing-commands` 明确称动态 shell 语法会被拒绝。两者冲突，说明 bundle 保留了兼容执行路径，但当前产品表面未承诺它。结论：

- 静态 command prompt 和参数替换是确认支持的；
- 不应依赖 `` !`cmd` `` 或 fenced `!`；
- command 子进程变量能否从当前 UI 路径到达，标为**未端到端验证**。

## 4. Commands、Skills、Hooks、Agents、MCP 生命周期

### 4.1 总体启动顺序

每次 app/session runtime 启动时：

1. 读取用户、工作区和 CLI 配置；
2. 解析插件候选、manifest、启用状态；
3. 为已启用插件建立 data directory；
4. 汇总 command roots、skill roots、hooks、MCP definitions、agent profiles；
5. 构造 runtime，连接 MCP，注册工具；
6. session 运行时触发 hooks、加载 skills/commands、调度 agents。

日志事件 `bootstrap.app.startup.plugins.completed` 会记录 enabled plugin、root、hook、MCP、skill 数量。来源：bundle `Ihe` 和 `~/.zcode/cli/log/zcode-*.jsonl`。

禁用插件仍可出现在插件列表，但其 command/skill/MCP/hook root 为空。`zcode plugins list --json` 对本机禁用的 `android-emulator` 显示：

- `declaredMcpServerNames: ["android-emulator"]`
- `mcpServerNames: []`
- `skillRootCount: 0`
- `commandRootCount: 0`

### 4.2 Commands

发现优先级（先到者胜）：

1. 显式 roots
2. `~/.zcode/commands`
3. `~/.agents/commands`
4. 从 cwd 向 repo root 的 `.zcode/commands`
5. 工作区 `.agents/commands`
6. 已启用插件 command roots

规则：

- 递归扫描 `.md`；子目录转成 `:`，如 `review/code.md` -> `/review:code`。
- 名称匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`。
- 按规范化名称去重，首个命中胜出。
- frontmatter 支持 `description`、`argument-hint`、`allowed-tools`、`model`、`skills`、`disable-noninteractive`。
- `$ARGUMENTS` 为完整参数；`$1`、`$2` 为位置参数。
- 启用插件可在 manifest 中声明 command metadata，ZCode 会在插件 data dir 的 `generated-commands/` 物化 `.md`。

来源：`diagnosing-commands/SKILL.md`；bundle `VPo`、`KPo`。

### 4.3 Skills

发现优先级与 commands 相同。规则：

- skill 是 `<dir>/SKILL.md`。
- 必需 frontmatter：`name`、`description`；description 超过 1024 字符会丢弃。
- 模型可见触发信息是 name、截断到约 250 字符的 description、`when_to_use`。
- 同名 skill 都会被发现，但加载时首个同名项胜出；plugin skill 可用 `plugin:skill` 限定名。
- Skill 工具按需加载正文，并在模型上下文中附带 base directory。

来源：`diagnosing-skills/SKILL.md`；bundle `_gn`/`skillHandler`。

### 4.4 Hooks

支持且仅支持七个事件：

```text
SessionStart
UserPromptSubmit
PreToolUse
PermissionRequest
PostToolUse
PostToolUseFailure
Stop
```

配置来源：

- 用户/工作区 config：`hooks.events.<Event>`，必须显式 `hooks.enabled: true`。
- 插件：`hooks/hooks.json` 或 manifest `hooks`；只要存在 plugin hook，runner 自动启用。

matcher 是大小写敏感正则。工具事件匹配 tool name；存在 `Task`/`Agent`、`ApplyPatch`/`Write`/`Edit` 兼容映射。

hook 类型：

- `command`: shell string，可设 `shell`、`timeout`（秒）、`timeoutMs`
- `process`: executable + `args[]`，`timeoutMs`（毫秒）

执行是同步内联的；`async` 当前没有 runtime 效果。默认 timeout 60 秒。

输出：

- stdout 为空：通过；
- stdout 为严格 JSON：可返回 `additionalContext`、permission decision、updated input、Stop continuation 等；
- exit 0：通过；
- exit 2：阻断；
- 其他非零：失败。

Stop continuation 最多三次。第三方插件 hooks 与内置 hooks 一样可执行，没有 marketplace trust gate。

来源：`diagnosing-hooks/SKILL.md`；bundle `FPo`、`P_n`、`A_n`。

### 4.5 Agents / Subagents

非插件 agent roots：

- 用户：`~/.zcode/agents/**/*.md`
- 工作区：`<cwd>/.zcode/agents/**/*.md`

agent Markdown 必须有 `name` 和 `description` frontmatter；还可声明：

- `model`
- `color`
- `permissionMode`
- `maxTurns`
- `tools`
- `disallowedTools`
- `skills`
- `background`
- `mcpServers`

工作区 agent 的 `permissionMode` 被移除，不能由项目文件提升权限。

插件 agent 实际启动路径：

1. `bfe/cBr` 从 manifest `agents` 和默认 `agents/*.md` 枚举组件；
2. `Oqr` 只读取已启用插件；
3. 解析 `<plugin-root>/agents/<name>.md`；
4. 注册限定名 `<plugin-name>:<agent-name>`；
5. bare name 仅在全局唯一且不与保留名冲突时提供；
6. profiles 传入 runtime 的 `subagentProfiles`。

证据：bundle `bfe`（约 byte 8,742,619）、`Oqr`（约 byte 8,948,776）、`$vt`/`dZr`（约 byte 8,956,766）。

**版本内冲突**：`diagnosing-plugins/SKILL.md` 说 `agents` “recorded but not executed”，但 bundle 有上述明确执行路径，`zcode-configuration-guide` 也说插件可贡献 agents。当前版本应以 bundle 路径为准，但因无内置 agent 插件样例，端到端状态标为**源码确认、实物未验证**。

### 4.6 MCP

配置来源与覆盖：

1. CLI override
2. environment
3. user
4. workspace
5. system/plugin base

同 scope 下 `.zcode` 优先；只有该 scope 没有 MCP 时才回退到 `.agents/mcp.json`。所有 scope 当前都自动信任并连接。

传输：

- stdio：`command` 必需；可选 `args`、`cwd`、`env`、`enabled`、`timeoutMs`
- http/sse：`url` 必需；可选 `headers`、`oauth`、`enabled`、`timeoutMs`
- 省略 `type` 时，`command` 推断 stdio，`url` 推断 http

插件 server 内部名称转为 `plugin:<plugin-id>:<server>`，模型可见工具名规范化为：

```text
mcp__<server_name_with_underscore>__<raw_tool_name>
```

例如 `android-emulator` 的 `android_preflight` 显示为 `mcp__android_emulator__android_preflight`。

连接状态为 `connecting | connected | disabled | disconnected | failed | untrusted`，并包含 transport、toolCount、updatedAt、error 和可选 OAuth authorization URL。

来源：`diagnosing-mcp/SKILL.md`；Android README；bundle `YCo`、`JCo`、`Nye`/`pD` schema。

## 5. ZCode CLI

### 5.1 顶层命令

`zcode --help` 实测：

```text
app-server
commands
doctor
login
logout
plugins
skills
tui
version
```

主要 headless options 包括 `--prompt`、`--attach`、`--cwd`、`--mode`、`--settings`、`--max-turns`、tool allow/deny list、`--resume`、`--target`、`--json`。

当前 parser 没有子命令专用 help。`zcode app-server -h`、`zcode plugins -h` 都回到顶层 help。

### 5.2 插件 CLI

bundle 中的准确 usage：

```text
zcode plugins [list|enable <plugin-id-or-name>|disable <plugin-id-or-name>|uninstall <plugin-id-or-name> [--force]]
```

支持 `--json`。enable/disable 输出写入路径，且变更只保证对新 session 生效。

TUI 内对应：

```text
/plugins [list|enable <plugin>|disable <plugin>|uninstall <plugin> --force]
```

注意：内置 Android/iOS README 仍展示：

```sh
zcode --plugin-dir /absolute/path/to/plugin
```

但 `0.15.2` 实测返回 `Unknown option '--plugin-dir'`。当前版本不能把它当作有效安装方式。

## 6. ZCode Protocol

### 6.1 传输与消息包

启动：

```sh
zcode app-server
```

别名 `agent-server` 在 parser 中仍被接受，但 help 不展示。

协议名和版本来自 session snapshot：

```json
{"name":"ZCode Protocol","version":1}
```

传输是 stdin/stdout NDJSON：

- 每行一个 JSON object；
- 空行忽略；
- EOF 前最后一个无换行 object 仍处理；
- 输出也是一行一个 JSON；
- 请求默认串行；
- response、`session/stop`、`prompt/enhance/cancel`、`plugins/cancelOperation` 绕过普通处理队列。

消息 envelope：

```ts
type Id = string | number;

type Request = {
  id: Id;
  method: string;
  params?: unknown;
  trace?: {
    traceId?: string;
    parentId?: string;
    spanId?: string;
    traceparent?: string;
  };
};

type Notification = Omit<Request, "id">;
type Success = { id: Id; result: unknown };
type Failure = {
  id: Id;
  error: { code: number; message: string; data?: unknown };
};
```

没有 `jsonrpc: "2.0"` 字段，也没有 `initialize` 方法。实测首条 `session/list` 可直接成功。

来源：bundle `Mye`/`Dye`/`Wkt`（约 byte 351,972）、`Khe`（约 byte 9,111,092）。

### 6.2 客户端调用服务端的方法

以下列表来自 bundle `at`/`J7o`（约 byte 389,137）。

#### Session

```text
session/create
session/resume
session/list
session/read
session/messages
session/events
session/subscribe
session/send
session/steer
session/stop
session/cancelBackgroundTask
session/fork
session/compact
session/goal
session/rewind
session/rewindCascade
session/previewFileRewind
session/applyFileRewind
session/close
session/setModel
session/setThoughtLevel
session/updateRuntimeModelConfig
session/setMode
session/usage
```

关键参数：

- `session/create`
  - 必需 `workspace`
  - 可选 `sessionId`、`parentSessionId`、`mode`、`model`、`runtimeModel`、`persistence`、`thoughtLevel`
  - 可选 `mcpServers`、`toolAllowlist`、`toolDenylist`
  - 可选 `importedHistory`，目前 source 只接受 `claudeCode`
- `session/send`
  - `sessionId`、`content`
  - 可选 attachments、expected revisions、runtimeModel、integrated terminal shell
- `session/subscribe`
  - `sessionId`
  - `deliveryKind`: `desktop-continuous | web-remote-replayable`
  - 可选 `afterSeq`、`includeSnapshot`
- `session/steer`
  - 可选返回 `queued` 或 `rejected`
  - rejected reason：`no_active_turn | expected_turn_mismatch | turn_not_steerable | empty_input | input_too_large`

`workspace` 严格形态：

```json
{
  "workspacePath": "/absolute/path",
  "workspaceIdentity": "optional stable identity",
  "workspaceKey": "required key"
}
```

#### Workspace / model

```text
workspace/readState
workspace/updateProviderRegistry
workspace/upsertModelProvider
workspace/removeModelProvider
workspace/setDefaultModel
workspace/setDefaultThoughtLevel
workspace/setDefaultMode
workspace/generateText
```

Protocol 可传完整 `runtimeModel`：revision、generatedAt、model ref、provider definition、thoughtLevel。provider kind 只接受 `anthropic | openai | openai-compatible`，API format 支持 `anthropic-messages | openai-chat-completions | openai-responses`。

#### MCP

```text
mcp/list
```

参数包括 workspace、可选 server 数组和 `mode: connect | status`。如果请求显式给 `mcpServers`，该列表覆盖普通配置层；否则合并 plugin MCP 与用户/工作区配置。

#### Plugins

```text
plugins/list
plugins/setEnabled
plugins/overview
plugins/marketplace/list
plugins/marketplace/add
plugins/marketplace/remove
plugins/marketplace/update
plugins/install
plugins/cancelOperation
plugins/uninstall
plugins/update
plugins/restoreBuiltin
plugins/configure
plugins/validate
plugins/describe
```

这些方法覆盖 Desktop Plugin Management 所需的发现、市场、安装、启用、配置、更新和卸载完整生命周期。

#### Prompt / usage

```text
prompt/enhance
prompt/enhance/start
prompt/enhance/cancel
usage/stats
```

### 6.3 服务端通知与反向请求

服务端通知：

- `session/event`: session 事件 envelope
- `state.updated`: server/workspace/session 状态 patch
- `prompt/enhance/result`: 异步 prompt enhance 结果

服务端反向请求客户端：

```text
interaction/requestPermission
interaction/requestUserInput
interaction/requestProviderRuntimeHeaders
```

反向请求 id 形如 `server-1`。客户端必须用普通 success/error envelope 回应。权限请求包含 sessionId、turnId、toolCallId、toolName、reason、riskLevel、input、options；客户端可返回 `allow | deny | escalate | modify`，以及 modifiedInput、permissionUpdates。

用户输入请求支持 prompt、questions、options、multiSelect、schema；返回 `accept | decline | cancel`。

provider runtime headers 请求用于模型请求或 captcha retry，携带 workspace、modelRef、providerId；客户端返回 headersApplied 等状态。

无客户端 sink、取消、超时分别使用 `-32020`、`-32021`、`-32022`。反向请求可重发，permission/user input 初始约 1 秒，指数退避上限 10 秒。证据：bundle `requestClient`、`gWr`。

### 6.4 Session 事件

`session/event.params` 公共字段包括：

```text
eventId
sessionId
turnId?
seq
traceId?
timestamp
deliveryKind?
type
payload
```

事件类型：

```text
session.created
session.resumed
session.updated
session.titleUpdated
session.closed
turn.started
turn.steerQueued
turn.steerDrained
turn.completed
turn.failed
message.upserted
message.removed
part.started
part.delta
part.upserted
part.removed
model.streaming
tool.updated
permission.requested
permission.resolved
userInput.requested
userInput.resolved
checkpoint.created
rewind.triggered
streamRecovery.updated
```

`model.streaming.kind`：

```text
start
finish
error
text_start
text_delta
text_end
reasoning_start
reasoning_delta
reasoning_end
tool_input_start
tool_input_delta
tool_input_end
tool_call
```

`tool.updated.kind`：

```text
scheduled
started
progress
result
error
batch
raw
```

事件序列按 delivery kind 独立维护，可用 `afterSeq` 重放。源码会合并连续 streaming delta，并在已从 model stream 发送完整 tool input 后，从后续 scheduled event 省略重复 input，改写为 `inputOmitted: true`、`inputRef: "model_stream"`。

来源：bundle `gSt`/`K7o`（约 byte 371,000）、`AWr`/`pVr`（约 byte 9,043,000）。

### 6.5 错误

实测：

| code | 含义 | 触发 |
|---:|---|---|
| `-32700` | Parse error | 输入不是 JSON |
| `-32600` | Invalid ZCode Protocol message | JSON 不符合四种 envelope |
| `-32601` | Method not found | 未知 method |
| `-32602` | Invalid params | method 参数未通过严格 Zod schema |

源码声明：

| code | 含义 |
|---:|---|
| `-32603` | Internal error |
| `-32004` | Session unavailable / not found |
| `-32020` | 没有附着 Protocol client，无法反向请求 |
| `-32021` | 反向请求被取消 |
| `-32022` | 反向请求超时 |

探测样例：

```text
input:  not-json
output: {"error":{"code":-32700,"message":"Parse error"},"id":"parse-error"}

input:  {"id":1,"method":"bogus","params":{}}
output: {"error":{"code":-32601,"message":"Method not found: bogus"},"id":1}
```

只有 `id` 没有 method/result/error 的对象会被识别为无效消息；本次管道探测未稳定观察到输出，bundle schema 明确要求其失败，具体静默原因标为**未知**。

### 6.6 Session 存储与 transfer 边界

默认 session store 是 SQLite：

```text
~/.zcode/cli/db/db.sqlite
```

配置项是 `storage.sessionDbPath`，环境变量 `ZCODE_SESSION_DB_PATH` 或 `ZCODE_SESSION_DB` 可覆盖。`zcode app-server` 启动时先对这个路径执行 SQLite migration，再把 store 注入 Protocol app。`session/resume` 从 store 读取 session record 和 messages；snapshot 还会读取 todos、goal、usage、goal verification entries 等持久化数据。

`session/create.persistence` 只有：

```text
immediate
deferred
```

- 省略时为 `immediate`。
- `deferred` session 不会作为普通 in-memory session 补入 `session/list`。
- 对 deferred session 第一次 `session/send` 时，runtime 将其切换为 `immediate`。
- `session/close` 只关闭 runtime 并从当前 app-server 的内存 map 移除；没有证据表明它删除 SQLite 记录。可用 `expectedPersistence` 做条件关闭。

当前协议没有名为 `session/transfer`、`session/export` 或 `session/import` 的方法。与 transfer 最接近的三个机制必须区分：

1. **历史导入**：`session/create.importedHistory` 只接受 `source: "claudeCode"`，至少一条 user/assistant message；每条只包含 role、content 和可选 timestamp。指定 `sessionId` 只允许与 imported history create 同时使用。它不是任意 ZCode session 的无损导入，tool call、reasoning、checkpoint 等结构不在该 schema 中。
2. **宿主内 fork**：`session/fork` 从已持久化 session 的目标消息处分叉，创建新 session 并复制可见消息链；这是同一 session store 内的派生，不是跨主机传输。
3. **事件交付/重放**：`session/subscribe.deliveryKind` 的 `desktop-continuous` 与 `web-remote-replayable` 控制事件投递；后者配合 `afterSeq` 和 `includeSnapshot` 支持远端 client 重连重放。它不等于转移 session 所有权或复制底层数据库。

`session/read`、`session/messages`、`session/events` 可供外部 client 读取协议公开的数据，但没有对应的通用写回/import schema。因此仅凭当前 Protocol 不能证明可把一个完整 ZCode session 无损迁移到另一台主机。数据库文件能否离线复制、跨版本迁移以及 Desktop 的云端 session transfer 流程均为**未知**，不应由 SQLite 路径反推。

来源：bundle 默认配置 `zo.storage`（约 byte 574,425）、`P9r`/`s7`（约 byte 8,709,587）、schema `Hkt`/`Gen`/`Uye`（约 byte 352,932）、handlers `yzo`/`DWr`/`OWr`/`rVr` 和 `session/send`（约 byte 9,030,000）。

## 7. 本地安装、启用和持久化

### 7.1 Desktop 支持路径

内置指南确认：

- Settings -> Plugin Management -> Discover：
  - 安装 marketplace 中的插件；
  - `+` 可添加 GitHub repo、Git URL、本地目录或文件。
- Installed：
  - enable/disable；
  - Advanced 配置 `userConfig`；
  - uninstall。

新安装插件默认启用。内置插件只能禁用，不能真正删除；“卸载”会写 suppression marker。

### 7.2 Protocol 支持路径

本地 marketplace 可通过：

1. `plugins/marketplace/add`，`source` 指向本地目录或文件；
2. `plugins/install`，给出 plugin name、marketplace、scope；
3. `plugins/setEnabled`。

marketplace source 支持：

- relative path string
- `directory`
- `github`
- `git`
- `url`（git 或 zip）
- `git-subdir`

`npm`、`pip` 不支持。依赖按 `name@marketplace` 解析，跨 marketplace 需要 allowlist。

安装前可调用：

```json
{
  "id": 1,
  "method": "plugins/validate",
  "params": {
    "workspace": {
      "workspacePath": "/absolute/path",
      "workspaceKey": "stable-key"
    },
    "source": "/absolute/path/to/plugin"
  }
}
```

`pluginName`、`marketplace`、`source` 都是可选定位条件；返回：

```ts
{
  ok: boolean;
  diagnostics: Diagnostic[];
  compatibility: {
    runnable: string[];
    diagnosticOnly: string[];
    unsupported: string[];
  };
}
```

当前 handler 的固定 compatibility 分类是：

- runnable：`skills`、`commands`、`mcpServers`、`userConfig`
- diagnosticOnly：`hooks`、`agents`、`lspServers`、`outputStyles`、`channels`、`settings`
- unsupported：`mcpb`、`dxt`、`npm`、`hostPattern`、`pathPattern`

`ok` 仅表示 diagnostics 中没有 `severity: "error"`。它不是签名、来源可信度或运行时权限审计；且 `hooks`/`agents` 的 `diagnosticOnly` 与实际 runtime 加载路径冲突，不能据此判定组件不会执行。来源：bundle schema `Rwe`/`Mrn` 和 handler `RVr`（约 byte 388,825、9,097,853）。

### 7.3 CLI 支持路径

CLI 只提供：

```sh
zcode plugins list [--json]
zcode plugins enable <id-or-name>
zcode plugins disable <id-or-name>
zcode plugins uninstall <id-or-name> [--force]
```

CLI 0.15.2 没有 marketplace add/install 子命令，也不接受 `--plugin-dir`。因此“纯 CLI 本地首次安装”的受支持路径为**未知/未提供**；应使用 Desktop 或 Protocol。

### 7.4 存储布局

默认根：

```text
~/.zcode/cli/plugins/
  marketplaces/<marketplace>/marketplace.json
  cache/<marketplace>/<plugin>/<version>/
  data/<plugin-id>/
```

内置插件首启时从 app resources 物化到 cache，并写 `.zcode-plugin-seed.json`（含 source、marketplace、plugin、version、content hash）。这是幂等过程，内容/version 改变时重物化。

状态配置逻辑位于：

```text
~/.zcode/cli/config.json
  plugins.enabled
  plugins.dirs
  plugins.enabledPlugins
  plugins.options
  plugins.suppressedBuiltins
```

默认值：

```json
{
  "plugins": {
    "dirs": [],
    "enabled": true,
    "enabledPlugins": {},
    "options": {},
    "suppressedBuiltins": []
  }
}
```

本机没有 `~/.zcode/cli/config.json`，说明默认状态可在无文件时成立；当前 enable map 的 Desktop 持久化来源未直接观察，标为**未验证**。

## 8. ZCode 宿主 + Codex 外部执行引擎

这里必须区分三种身份：

1. **Protocol client**：启动并驱动 `zcode app-server` 的外部程序。
2. **模型/执行引擎**：接收 ZCode 构造的 prompt、tool schemas 和事件的 Codex runtime。
3. **插件进程**：hook 或 MCP server；skills/commands/agents 本身是由 ZCode 读取的内容，不是常驻进程。

### 8.1 Codex 能收到的宿主信息

若 Codex 作为 ZCode session 的外部执行引擎，ZCode 可投影：

- user/workspace `AGENTS.md`
- 已发现的 skill metadata，按需加载的 skill 正文和 base directory
- slash command 展开后的 prompt
- agent profiles 和 Agent tool
- ZCode 内置 tools 及已连接 MCP tools
- permission mode、tool allow/deny list
- workspace path
- session/turn 上下文、历史消息
- model、thought level、context window、runtime 状态
- Protocol event 中的 message/part/model/tool/permission/checkpoint 状态

证据：session snapshot schema `dm`、event schema `gSt`、skill handler、runtime `dZr`。

### 8.2 插件可收到的宿主信息

按组件：

| 组件 | 可见宿主信息 |
|---|---|
| Skill | skill base directory；正文中的 `${ZCODE_SKILL_DIR}`；模型已有的 session/workspace 上下文 |
| Command | 用户参数；command metadata；模型已有上下文；shell expansion 路径若可达则含 project/session/plugin 信息 |
| Hook | event JSON 输入；project path、session id；plugin root/data/id/name；tool event 时含 tool name/input/result 等 |
| Agent | frontmatter profile、system prompt；继承/约束后的 tools、skills、MCP、model、maxTurns；作为新 child session 运行 |
| MCP | manifest 显式展开的 plugin root/data/project/user config/ZCODE env；通过 MCP request 得到工具参数 |

### 8.3 Protocol client 能调用的宿主信息

Protocol client 可显式读取或管理：

- session list/read/messages/events/usage
- workspace state 和 model catalog
- MCP status
- plugin list/overview/describe/validate，以及 marketplace/install/enable/configure 生命周期
- usage stats
- session model/mode/thought level、goal、fork/rewind/compact

这比普通 plugin MCP 进程的默认可见范围更大。若 Codex adapter 同时充当 Protocol client，它可以实现这些宿主调用；若 Codex 只是 ZCode 内部的模型执行器，则不会自动获得这些 RPC。

### 8.4 明确不能推断的能力

没有证据支持以下说法：

- plugin MCP 可直接调用 ZCode Protocol；
- plugin 可直接读取当前 UI selection、窗口、剪贴板或 Desktop 私有状态；
- plugin 自动得到 session DB、task index 或 ZCode credentials；
- plugin 自动得到用户全部环境变量或其他插件的 private data；
- Codex 模型能直接调用 `plugins/*`、`workspace/*` RPC；
- `provider: "codex"` 是当前 ZCode Protocol 的 runtime provider kind。

最后一点容易混淆：task metadata 的历史 provider enum 包含 `codex`，但 Protocol runtime model provider kind 只接受 `anthropic`、`openai`、`openai-compatible`。这不能证明存在“Codex engine”专用 transport。

### 8.5 适配器设计结论

若目标是“ZCode 做宿主、Codex 做外部执行引擎”，最小可靠接口应是：

1. adapter 作为 ZCode Protocol client 启动 `zcode app-server`；
2. 用 `session/create|resume` 建立宿主 session；
3. 用 `session/subscribe` 或 `session/events` 消费状态；
4. 用 `session/send|steer|stop` 驱动 turn；
5. 处理三类 `interaction/*` 反向请求；
6. 将 `session/event` 映射为 Codex 的 message、reasoning、tool call/result、permission 状态；
7. 不让 Codex 直接扫描 ZCode 私有目录来替代 RPC；
8. 对 plugins/MCP/skills 的宿主发现能力，使用 Protocol 或 ZCode 投影后的工具，不假设进程内 API。

这是由现有协议能力推出的适配边界，不代表本机 ZCode 已提供现成的 Codex adapter。

## 9. 未知项与版本矛盾

1. **Protocol 没有公开版本协商**：snapshot 固定返回 version 1，但没有 `initialize`/capabilities handshake；跨版本兼容策略未知。
2. **Protocol schema 未单独发布**：只能从 bundle 的 Zod schema恢复；没有发现 JSON Schema 或 TypeScript declaration 文件。
3. **外部 Codex transport**：没有发现专用 `codex` provider/runtime schema；如何把 Codex process 接入 ZCode model adapter 未公开。
4. **Plugin -> Protocol**：没有 capability token、socket path 或自动 client handle 注入证据。
5. **Agent 文档冲突**：bundle 会加载 plugin agents；`diagnosing-plugins` 却称只记录。以当前 bundle 为准，但需真实插件回归验证。
6. **Command shell expansion 冲突**：bundle 保留执行代码，内置指南称拒绝；不要依赖。
7. **`--plugin-dir` 文档过时**：Android/iOS README 声称支持，CLI 0.15.2 实测拒绝。
8. **Hooks validator 表述冲突**：`plugins/validate` compatibility 返回中把 hooks 列为 `diagnosticOnly`，但实际 startup adapter 和内置 hook 指南都明确执行 plugin hooks。该 compatibility 字段不能当作 runtime 执行能力表。
9. **启用状态实际文件**：bundle 和指南指定 `~/.zcode/cli/config.json`，但本机该文件不存在仍有默认启用插件；Desktop 是否还有上层配置注入未知。
10. **安装安全模型**：plugin hooks 与 MCP 可执行本地代码，且当前所有来源自动连接/运行；没有发现安装后逐组件授权或签名强制校验。
