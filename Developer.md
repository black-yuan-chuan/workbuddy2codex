# WorkBuddy2Codex 开发者文档

本文件记录插件的全部实现逻辑：架构、模块职责、代理的协议翻译、凭据读取、
Codex 配置写入、进程管理与自检方法。面向需要修改、排查或重新打包的人。

用户安装与使用说明见 [`README.md`](README.md)。

## 1. 整体架构

```
┌──────────────────────────── VS Code 扩展宿主（Node.js） ────────────────────────────┐
│                                                                                     │
│  extension.js   激活入口：命令注册、状态栏、自动启动、轮询                         │
│      │                                                                              │
│      ├── controller.js     代理生命周期 + 状态聚合（running/pid/models/credits）    │
│      │      ├── proxy-process.js   spawn / 停止 / pid 文件 / 端口占用者识别         │
│      │      ├── proxy-client.js    到本地代理的 HTTP 客户端（health/models/credits） │
│      │      └── codex-config.js    幂等写入 ~/.codex/config.toml + catalog          │
│      │                                                                              │
│      └── panel.js + webview-html.js + media/*  侧边栏 Webview（只读 snapshot）      │
└──────────────────────────────────┬──────────────────────────────────────────────────┘
                                   │ detached 子进程，PORT=8401
                                   ▼
┌──────────────────────── proxy/proxy.mjs（零依赖 Node 进程） ───────────────────────┐
│  HTTP 服务 127.0.0.1:8401                                                           │
│   /healthz  /v1/credits  /w2c/models  /w2c/catalog  /v1/models                      │
│   /v1/responses  /v1/chat/completions                                               │
│        │                                                                            │
│        ├── shared/credential.mjs   读 WorkBuddy 凭据、刷新 token                     │
│        ├── shared/atrest.mjs       解密桌面端 at-rest 凭据信封                       │
│        ├── shared/catalog.mjs      模型目录（live + 兜底 + Codex catalog 生成）      │
│        └── shared/credits.mjs      剩余积分只读汇总                                  │
│                                   │                                                 │
│                                   ▼   HTTPS                                                │
│                     WorkBuddy 国内版（copilot.tencent.com / codebuddy.cn）           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

要点：

- 代理是**独立进程**，`detached: true` 且 `unref()`，关闭 VS Code 后仍在运行；
  扩展下次启动时通过 pid 文件 + 端口监听者识别并接管。
- 扩展与代理之间只有 HTTP；没有 IPC、没有端口转发、没有开机自启与看门狗。
- 所有依赖都是 Node 内置模块，**不需要 `npm install`**，打包用 `--no-dependencies`。

## 2. 目录与文件职责

| 文件 | 职责 |
|---|---|
| `package.json` | 扩展清单：激活事件 `onStartupFinished`、视图容器、命令、设置项 |
| `src/extension.js` | `activate()`：创建 controller、状态栏、Webview provider、注册 9 个命令、首次刷新、自动启动 |
| `src/controller.js` | 状态机 + 副作用编排；对 UI 只暴露 `snapshot()` |
| `src/proxy-process.js` | 子进程管理：`spawnProxy` / `stopProxy` / `readPid` / `portOwner` / `isAlive` |
| `src/proxy-client.js` | `node:http` 实现的 JSON 客户端（health 2.5s，其余 30s 超时） |
| `src/codex-config.js` | `config.toml` 与 catalog 的幂等写入、备份、回滚 |
| `src/paths.js` | 状态目录 `~/.workbuddy2codex`、pid/日志路径、日志尾部读取 |
| `src/node-locator.js` | 找 node：显式配置 → PATH → 常见安装目录 → VS Code 自带 Electron |
| `src/panel.js` | `WebviewViewProvider`：把 snapshot 推给面板，接收按钮消息 |
| `src/webview-html.js` | 生成内联 CSS/JS 的 HTML，带 CSP nonce |
| `media/panel.js` | 面板渲染与 `postMessage` 命令 |
| `media/panel.css` / `icon.svg` | 样式与活动栏图标 |
| `proxy/proxy.mjs` | 本地代理服务：路由、协议翻译、上游调用、错误分类 |
| `proxy/shared/*.mjs` | 凭据、at-rest 解密、模型目录、积分 |
| `dev/check-package.mjs` | 打包前校验清单引用的文件都存在 |
| `dev/smoke.cjs` | 无 VS Code 环境下用桩对象验证激活/命令/配置写入 |

## 3. 扩展启动流程（`extension.js`）

1. `activate(context)` 由 `onStartupFinished` 触发。
2. 创建 `ProxyController`，订阅 `onDidChange` → 更新状态栏文本（`$(plug) WB <积分>`）。
3. 创建状态栏项，右侧、优先级 90，点击执行 `workbuddy2codex.showPanel`。
4. 注册 Webview provider（`retainContextWhenHidden: true`），确保面板隐藏时不丢状态。
5. 注册命令表：

   | 命令 ID | 处理函数 |
   |---|---|
   | `start` / `stop` / `restart` | `startProxy` / `stopProxy` / `restartProxy` |
   | `selectModel` | `selectModel`（QuickPick 或面板直传 id） |
   | `refreshCredits` | 立即查询积分 |
   | `syncCodexConfig` / `removeCodexConfig` | 写入 / 移除 Codex 配置 |
   | `openCodexConfig` | 用编辑器打开 `config.toml` |
   | `showPanel` | `workbuddy2codex.panel.focus` |

6. `refreshStatus()` 探测已存在的代理；若在跑则拉模型与积分。
7. 否则若 `autoStart` 为真（默认），静默调用 `controller.start()`，失败弹警告。
8. `startPolling()` 按 `creditsRefreshSeconds`（最小 15s，默认 60s）轮询状态与积分。
9. `saveSnapshot()` 把端口与所选模型写到 `~/.workbuddy2codex/state.json`。

`deactivate()`：停止轮询、释放事件、清空引用；**不杀代理**（代理是独立进程）。

## 4. 状态机与 `snapshot()`

`ProxyController` 的字段：`running`、`pid`、`health`、`models`、`credits`、
`error`、`busy`（`"" | "start" | "stop" | "model"`）、`lastUpdated`、`timer`、`polling`。

`snapshot()` 输出给 UI 的结构：

```js
{ running, pid, port, models, selectedModel, credits, error, busy,
  updatedAt, script, codexConfig, logs /* 日志尾部 40 行 */ }
```

`emit()` = `onDidChange.fire(snapshot())`。状态栏与面板**只读 snapshot**，不各自
维护副本，避免不一致。

### 4.1 `start({ silent })` 的顺序

1. 已 `running` 直接返回。
2. `busy = "start"`，清空 error，`emit()`。
3. `adoptRunning()`：请求 `/healthz`，若接口兼容且 `readPid(port)` 有值 → 接管，
   拉模型与积分后返回。
4. 若 `readPid()` 有值但仍不可用 → 报「端口上的代理无响应或版本不匹配，请重启代理」。
5. 检查 `script` 是否存在；不存在报「找不到 proxy/proxy.mjs」。
6. `portConflict()`：端口被**别的程序**占用时直接报错，不再启动注定失败的子进程。
7. `spawnProxy()` → `waitHealthy(20, pid)`。
8. 成功：`running = true`，非静默时弹信息提示，拉模型与积分。
9. 失败：`running = false`、`pid = null`、`clearPid()`、记录 `启动失败：…` 并抛出。
10. `finally`：清 `busy`，`emit()`。

### 4.2 `waitHealthy(attempts, pid)`

每轮 300ms：

- 若给了 `pid` 且进程已退出 → 立刻抛 `crashReason()`（不再盲等 6 秒）。
- 查 `portOwner()`；只有当「没给 pid」或「端口主人就是自己拉起的 pid」时才认为
  `/healthz` 成功属于本进程，避免把别人的监听当自己的启动成功。

### 4.3 `refreshStatus()`（轮询）

```
pid = readPid(port)
├─ 无 pid → running=false，清空 models/credits，error = portConflict()
└─ 有 pid → GET /healthz
     ├─ 接口兼容 → running=true，error=""
     └─ 不兼容/超时 → running=false，给出对应提示
```

这是历史 bug 的关键点：旧实现只信 pid 文件，旧版本残留进程占着端口时 pid 文件
失效，轮询就把「其实在跑」误判成「已停止」。现在 `readPid()` 会自愈（见 §5）。

## 5. 进程管理（`src/proxy-process.js`）

| 函数 | 说明 |
|---|---|
| `isAlive(pid)` | `process.kill(pid, 0)` 探测存在性 |
| `isProxyCommand(cmd)` | 按空白/引号切分参数，判断是否有以 `proxy.mjs` 结尾的参数 |
| `commandLineOf(pid)` | Windows 用 `Get-CimInstance Win32_Process`；Unix 读 `/proc/<pid>/cmdline` |
| `isProxyProcess(pid)` | `isProxyCommand(commandLineOf(pid))` |
| `portOwnerPid(port)` | Windows：`Get-NetTCPConnection -LocalPort <p> -State Listen` 取 `OwningProcess`；Unix：`lsof -ti tcp:<p> -sTCP:LISTEN` |
| `portOwner(port)` | `{ pid, command }` 或 `null` |
| `recordedPid(port)` | pid 文件中的值，且进程存活、命令行确实是 proxy.mjs |
| `readPid(port)` | 优先 pid 文件；否则用端口监听者识别本插件代理并**回写 pid 文件** |
| `clearPid(port)` | 删除 pid 文件 |
| `killTree(pid)` | Windows `taskkill /PID <p> /T /F`；Unix 先 `kill(-pid, SIGTERM)`，失败再 `SIGKILL` |
| `spawnProxy({script, configuredNode, port})` | detached 子进程，stdout/stderr 追加到日志，写入 pid 文件，返回 pid |
| `stopProxy(port)` | `readPid` → `killTree` → `clearPid`；无进程时也清理残留 pid 文件 |

`spawnProxy` 的环境变量：继承父进程 + `locateNode()` 的 env（Electron 兜底时为
`ELECTRON_RUN_AS_NODE=1`）+ `PORT`。

日志文件：`~/.workbuddy2codex/proxy-<port>.log`，每次启动先写
`[extension] start <ISO 时间> port=<port>`，便于对齐崩溃时间。

### 5.1 为什么要有端口占用者识别

旧版安装目录（如 `local.workbuddy2codex-0.1.0`）被删除后，进程仍可能存活并占着
8401；此时新进程 `listen` 直接 `EADDRINUSE` 退出，pid 文件指向的却是已死进程。
表现就是「面板先显示运行，几十秒后自己变未停止」。

修复后的行为：

- `readPid()` 能从端口反查出真正的代理进程并修复 pid 文件 → 轮询不再误判。
- `start()` 在拉子进程前先看端口主人，是别人就报可读错误并列出其命令行。
- `waitHealthy()` 同时盯子进程存活与端口归属，失败立即返回。

## 6. 本地代理（`proxy/proxy.mjs`）

### 6.1 运行契约

- 环境变量：`PORT`（默认 8401）、`WORKBUDDY_AUTH_FILE`（可选，显式指定凭据文件）。
- 只监听 `127.0.0.1`；`server.requestTimeout = 0`（长流式请求不超时）。
- `server.on("error")` 捕获 `EADDRINUSE`，打印一行
  `[workbuddy2codex] failed to start: port <p> already in use; ...` 后 `exit(1)`。
- `SIGINT` / `SIGTERM` → `process.exit(0)`。
- 请求体上限 64MB（`BODY_LIMIT`）。

### 6.2 路由

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/healthz`、`/` | `{ ok, service, port, pid, endpoints[] }` |
| GET | `/v1/credits` | 凭据 → `fetchCredits()` → 汇总 + `updatedAt` + `source` |
| GET | `/w2c/catalog` | `listModelsForCatalog()` → `toCodexCatalog()` |
| GET | `/w2c/models` | 面板用的精简模型表 `{ models, updatedAt }` |
| GET | `/v1/models`、`/models` | OpenAI 风格 `{ object:"list", data[] }` |
| POST | `/v1/responses`、`/responses` | Responses API：请求转 chat，SSE 再转回 Responses 事件 |
| POST | `/v1/chat/completions`、`/chat/completions` | 流式透传或本地聚合 |
| 其他 | * | 404 `no such route` |

`/healthz` 的 `endpoints` 含 `/v1/credits` 与 `/w2c/models`，扩展用它判断兼容性。

### 6.3 模型目录

- `listModelsForCatalog()`：先 `resolveCredential()` 再 `fetchLiveModels()`，成功则
  重建 `modelInfo` Map；任何异常回落到内置 `CN_FALLBACK_MODELS`（15 个模型）。
- 精简条目：`{ id, ctx, out, img, efforts, canOff }`，`infoOf(id)` 对未知模型给默认值
  （1M 上下文 / 32K 输出 / 支持图片 / 无 effort 约束）。
- `toCodexCatalog()` 生成 Codex 的 `model_catalog_json`，每条目由 `codexEntry()` 产出：
  `slug`、`display_name`、`description`（含积分倍率）、`context_window` /
  `max_context_window`（均取 `ctx`）、`max_output_tokens`（取 `out`）、
  `effective_context_window_percent: 95`、`default_reasoning_level`、
  `default_reasoning_summary`、`default_verbosity`、`default_service_tier`、
  `supported_reasoning_levels`（来自 `efforts`，描述取 `EFFORT_LABELS`）、
  `supports_reasoning_summaries` 与 `base_instructions`。
- 字段是严格的：缺 `base_instructions` 会让 Codex 拒绝启动，因此每条都给最小
  身份声明（"You are a coding agent running in the Codex CLI."）。

### 6.4 请求翻译：Responses → chat completions

`responsesToChat(reqBody)`：

1. `instructions` → 一条 `system` 消息。
2. `input` 支持字符串或数组；按 `type` 分流：
   - `function_call` → 累积到 `pendingAssistantToolCalls`，凑齐后作为一条
     `assistant`（`content: null` + `tool_calls`）提交（`flushAssistant()`）。
   - `function_call_output` → `role: "tool"` + `tool_call_id`。
   - `reasoning` → 收集 `summary[].text` 到 `pendingReasoning`，挂到同轮 assistant
     的 `reasoning_content`（网关 11155 要求回传）。
   - `item_reference` / `web_search_call` → 丢弃。
   - `message` → 角色归一（`developer`/`system` → `system`，其余 → `user`）；
     内容数组里的 `input_text`/`output_text`/`text`/`summary_text` 转 `text`，
     `input_image`/`image_url` 转 `image_url`，`refusal` 转 `text`；
     纯文本时退化成字符串，含图片时保留数组。
3. `tools`：只保留 `function` 类型，统一成 `{type:"function", function:{name,description,parameters}}`。
4. 透传 `tool_choice`、`temperature`、`top_p`、`max_output_tokens`/`max_tokens`。
5. 计算 `reasoning.effort` 后交给 `finalizeChatBody()`，返回 `{ body, effort }`。

### 6.5 `finalizeChatBody()`（上游兼容层）

- 删除 `STRIP_CHAT_FIELDS` 中上游不认识的 Responses 字段。
- `role: "developer"` → `"system"`。
- `tool_choice` 归一：上游只接受字符串（`none`/`auto`/`required`/函数名）；
  `none` 时连同 `tools` 一起删除。
- `reasoning_effort` 必须是模型声明过的值（`normalizeEffort`）。
- 思维链模式下，历史中每条 assistant 都必须有 `reasoning_content`，缺失补
  `"(no reasoning content recorded for this turn)"`（否则 400 / 11155）。
- `max_tokens` 截断到模型 `out` 上限；无有效值则删除。
- 强制 `stream: true`（上游只支持流式）。

### 6.6 上游安全策略与容错

| 处理 | 位置 | 原因 |
|---|---|---|
| `developer` → `system`、身份前言清洗 | `enforceUpstreamPolicy()` + `sanitizeDeep()` | 上游对 system/assistant 里逐字的第三方 agent 身份声明返回 11128；需深度遍历，含 `tool_calls[].function.arguments` |
| fetch 传输层重试（3 次，300ms 递增） | `fetchUpstreamRetry()` | keep-alive 连接被中间设备回收会 `TypeError: fetch failed`，重试安全 |
| 工具 JSON Schema 清洗 | `stripSchemaNoise()` / `sanitizeTools()` | 删除 `$schema`/`propertyNames`/`annotations`/`$comment`；`additionalProperties` 为对象时归一为 `true`；只删 schema 位置，不动 properties 里的同名业务参数 |
| 消息顺序归一 | `normalizeMessageOrder()` | assistant(tool_calls) 与对应 tool 结果被用户插话隔开会 400/11133，把匹配的 tool 结果上移 |
| 400/11133 时收缩 `max_tokens` | `callUpstream()` | 最多 6 次对半砍，仍失败则删除 `max_tokens` |

`callUpstream()` 是唯一出站入口：先 `resolveCredential()`，再执行上述清洗，最后
`postChat()`（`POST https://copilot.tencent.com/v2/chat/completions`，带
`Authorization: Bearer <accessToken>` 与 `X-User-Id`/`X-Domain`/`X-Product: SaaS`）。

### 6.7 响应翻译：chat SSE → Responses SSE

`relayAsResponses(upstreamStream, res, { model, stream, effort })` 消费上游
`data:` 行并维护三种「打开中的 item」：`reasoning`、`message`、`function_call`。

- 流式：先写 `response.created` / `response.in_progress`，随后按 delta 发
  `response.output_item.added`、`response.output_text.delta`、
  `response.reasoning_summary_text.delta`、`response.function_call_arguments.delta`。
- 切换 item 时 `closeOpen()` 发对应的 `*.done` 与 `response.output_item.done`。
- 结束后发 `response.completed`，附带完整 `responseEnvelope`（含 `usage`）。
- `usage` 优先取上游 `prompt_tokens`/`completion_tokens`/`reasoning_tokens`，
  缺失时按字符数 /4 估算。
- 非流式请求也走同一路径，只是不写 SSE，直接聚合出最终对象返回。

`/v1/chat/completions` 非流式时本地聚合 `content`、`reasoning_content`、
`tool_calls`（按 `index` 排序）后一次性返回；流式则原样透传上游字节。

### 6.8 错误分类

`classify(status, body)` → `errorStatusFor(kind)`：

| kind | 触发 | 返回给客户端 |
|---|---|---|
| `hard_credit` | 402 或命中积分不足文案 | 402 |
| `soft_rate` | 429 | 429 |
| `session_dead` | `Offline user session not found` 或 `12153` | 401（并 `invalidateCredential()`） |
| `not_found` / `server` | 404 / ≥500 | 502 |
| 其他 | — | 400 |

## 7. 凭据（`proxy/shared/credential.mjs`、`atrest.mjs`）

- 来源优先级：桌面端 auth 文件 → 代理自存的刷新副本
  `~/.workbuddy2codex/auth.json`。
- 桌面端路径（`workbuddy-desktop.info`）：
  - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\`，
    其次 `%APPDATA%\...` 同名目录
  - macOS：`~/Library/Application Support/CodeBuddyExtension/...`
  - Linux：`~/.config/CodeBuddyExtension/...`
- 支持两种格式：明文 JSON，以及 `accessToken` 为对象的 at-rest 加密信封。
- 加密信封的解密只需 WorkBuddy 的**可执行文件**，不需要它在运行：
  `atrest.mjs` 以 `ELECTRON_RUN_AS_NODE=1` 启动一个短命子进程，执行
  `process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()` 取密钥
  （带 10s 超时），再解出 token。
- `needsRefresh()`：到期前 5 分钟（`REFRESH_MARGIN_MS`）就刷新。
- `refreshCredential()`：`POST /v2/plugin/auth/token/refresh`，带 `X-Refresh-Token`、
  `X-Auth-Refresh-Source: workbuddy`；成功后写回自己的 `auth.json`（**不写回** App 的文件）。
- `invalidateCredential()`：丢弃缓存，下次重新读取。
- 所有上游请求 30s（`JSON_TIMEOUT_MS`）超时；token 刷新失败按 150ms×(n+1) 退避重试。

## 8. 积分（`proxy/shared/credits.mjs`）

- 上游：`POST {https://www.codebuddy.cn}/v2/billing/meter/get-user-resource`（只读）。
- 企业账号：`/billing/meter/get-enterprise-user-usage`，取 `limitNum - credit`。
- 个人账号：逐积分包汇总
  - 月度包（`CapacityType === 4`）看 `CycleCapacityRemain`
  - 一次性包看 `CapacityRemain`；过期或耗尽的不计入
  - 优先使用 `*Precise` 字符串字段保证精度
- 输出：`{ total, packages[], expiringSoon, enterprise, updatedAt }`；
  `expiringSoon` 为 72 小时内到期的额度。
- 面板/状态栏仅展示，不会消耗积分。

## 9. Codex 配置写入（`src/codex-config.js`）

- 位置：`CODEX_HOME`（若设置）否则 `~/.codex`；可用
  `workbuddy2codex.codexConfigPath` 覆盖。
- 托管内容：

  ```toml
  model = "<所选模型>"
  model_provider = "workbuddy2codex"
  model_catalog_json = "workbuddy2codex-catalog.json"

  [model_providers.workbuddy2codex]
  name = "WorkBuddy (local proxy)"
  base_url = "http://127.0.0.1:<port>/v1"
  wire_api = "responses"
  requires_openai_auth = false
  experimental_bearer_token = "local"
  ```

- 写入步骤（`syncCodexConfig`）：
  1. 备份为 `config.toml.bak-w2c-<ISO 时间>`。
  2. 首次接管前把原 `model`/`model_provider`/`model_catalog_json` 存到
     `.workbuddy2codex-original.json`（与 `config.toml` 同目录）。
  3. `upsertProviderSection()`：找到 `[model_providers.workbuddy2codex]` 到下一个
     `[` 之前，整段替换；不存在则追加。
  4. `setTopLevel()`：只改第一个 `[section]` 之前的同名键，避免误伤
     `[projects.*]` 里的 `model`。
  5. 若既没有传入 catalog、磁盘上也没有 catalog 文件 → 先抛错，**不写** config
     （Codex 缺目录会拒绝启动）。
  6. `normalizeToml()`：统一 LF、压缩连续空行、去行尾空白。
- 一律 **UTF-8 无 BOM**（Codex 遇到 BOM 解析失败）。
- `removeCodexConfig()`：删除 provider 段 → 用 `.workbuddy2codex-original.json`
  还原三个顶层键（原本不存在的键直接删掉）→ 删除 catalog 与原始值记录。
- `ensureManagedCatalog()`：仅当 `model_provider` 已是本插件时，才把最新的
  `/w2c/catalog` 结果同步写入 catalog 文件。

## 10. 面板（`src/panel.js`、`src/webview-html.js`、`media/*`）

- `PanelViewProvider` 订阅 `controller.onDidChange`，每次变化把 `snapshot()`
  通过 `postMessage({type:"state"})` 推给 Webview。
- `renderHtml()` 把 CSS/JS 内联进 HTML，配合 CSP `script-src 'nonce-...'`，
  不额外发资源请求。
- 面板消息：`ready` / `start` / `stop` / `restart` / `selectModel` /
  `refreshCredits` / `syncCodex` / `openConfig`。
- `media/panel.js` 只负责渲染与发消息，不含业务判断；`busy` 非空时禁用按钮。
- 日志区展示 `snapshot().logs`（`proxy-<port>.log` 末尾 40 行）。

## 11. 设置项（`package.json` 的 `contributes.configuration`）

| 键 | 类型 | 默认 | 读取位置 |
|---|---|---|---|
| `workbuddy2codex.port` | number | 8401 | `ProxyController.port` |
| `workbuddy2codex.autoStart` | boolean | true | `activate()` |
| `workbuddy2codex.nodePath` | string | "" | `locateNode()` |
| `workbuddy2codex.codexConfigPath` | string | "" | `codex.configPath()` |
| `workbuddy2codex.creditsRefreshSeconds` | number | 60（最小 15） | `startPolling()` |
| `workbuddy2codex.proxyPath` | string | "" | `locateProxyScript()` |

## 12. 状态文件

| 路径 | 内容 |
|---|---|
| `~/.workbuddy2codex/proxy-<port>.pid` | 代理进程 pid（自愈后可被重写） |
| `~/.workbuddy2codex/proxy-<port>.log` | 代理 stdout/stderr + 启动标记 |
| `~/.workbuddy2codex/auth.json` | 刷新后的凭据副本 |
| `~/.workbuddy2codex/state.json` | 端口、所选模型、保存时间 |
| `~/.codex/workbuddy2codex-catalog.json` | 供 Codex 读取的模型目录 |
| `~/.codex/.workbuddy2codex-original.json` | 接管前的顶层配置，用于回滚 |

## 13. 调试与自检

### 13.1 在 VS Code 里调扩展

```powershell
git clone https://github.com/black-yuan-chuan/workbuddy2codex.git
cd workbuddy2codex
code .                       # 用 VS Code 打开本项目
# 按 F5 → 启动扩展开发宿主（Extension Development Host）
```

也可以在扩展开发宿主里执行 `Developer: Install Extension from Location...`
并选择本项目根目录，效果等同装一个本地开发版。

调试注意：

- 扩展宿主里的“重载窗口”只重载扩展代码，**不会**杀掉独立代理进程；
  改完代理代码要点一次「重启代理」。
- 想断点调代理，直接用 `$env:PORT=8402; node --inspect proxy/proxy.mjs`，
  避免和扩展托管的 8401 实例抢端口。

### 13.2 自动化自检

```powershell
npm run check      # node --check：扩展入口 + 代理
npm run smoke      # 用 vscode 桩验证激活、命令注册、config 写入/回滚
npm run prepackage # 校验清单引用的文件都在仓库
```

`smoke` 会把 `CODEX_HOME` 指向临时目录，不会改动真实配置；它会断言：

- 9 个命令都已注册、Webview provider 已注册；
- 写入后 `model`/`model_provider`/`model_catalog_json` 正确；
- 无 BOM、LF 换行、备份存在；
- 重复写入不产生重复段；
- 移除后恢复原始顶层值，且 `[projects.*]` 段保留。

手动验证代理：

```powershell
$env:PORT=8402; node proxy/proxy.mjs     # 另开终端
curl http://127.0.0.1:8402/healthz        # 应返回含 pid 的 JSON
curl http://127.0.0.1:8402/w2c/models     # 模型列表
```

验证端口占用与自愈：

1. 先启动一个代理，删掉它的 pid 文件，再到扩展里点「启动」→ 应直接接管。
2. 用别的程序占住端口，再点「启动」→ 应提示端口被占用并给出 PID/命令行，而
   不是静默失败。
3. 占用端口时手动跑 `node proxy/proxy.mjs` → 日志应只有一行
   `failed to start: port <p> already in use`，退出码 1。

## 14. 打包与发布

```powershell
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension workbuddy2codex-<version>.vsix --force
```

- `.vscodeignore` 排除 `dev/`、`.git/`、`*.vsix`、`*.log`、`node_modules/`。
- `vscode:prepublish` 会先跑 `dev/check-package.mjs`。
- 升版本只改 `package.json` 的 `version`，并同步 README 里的安装示例文件名。
- 安装后必须**重载窗口**，扩展版本才会从旧目录切到新目录；旧目录会在
  `.obsolete` 中标记，重载后清理。

## 15. 历史坑位清单

| 现象 | 根因 | 处理 |
|---|---|---|
| 400 / 11128 `Illegal API invocation from an unapproved channel` | system/assistant 中出现其他厂商 agent 身份前言（精确子串匹配） | `sanitizeDeep()` 深度替换，覆盖 `tool_calls.arguments` |
| 400 / 11155 | 思维链模式下历史 assistant 缺 `reasoning_content` | 请求侧回传 `reasoning_content`，缺失补占位 |
| 400 / 11133 `model_param_invalid` | 工具 schema 带 `$schema` 等非标准键；assistant(tool_calls) 与 tool 结果之间被插话 | `stripSchemaNoise()`、`normalizeMessageOrder()`、必要时收缩 `max_tokens` |
| `TypeError: fetch failed` | keep-alive 连接被中间设备回收 | `fetchUpstreamRetry()` 重试 3 次 |
| `EADDRINUSE` 且面板反复"自己停止" | 旧安装残留进程占端口 + pid 文件失效 | `portOwner()` 识别 + `readPid()` 自愈 + 启动前冲突检查 |
| Codex 不显示模型 | 缺 catalog 或未新开会话 | 写入前校验 catalog 可落盘；UI 提示新开会话 |
| Codex 启动报 TOML 解析失败 | 文件带 BOM 或 CRLF 混乱 | `writeTextNoBom()` + `normalizeToml()` |

## 16. 第三方与许可

`proxy/shared/atrest.mjs`、`credential.mjs`、`credits.mjs`、`catalog.mjs` 的部分
实现移植自 MIT 许可的 `dsh-workbuddy-connect`，署名与许可原文见
`THIRD-PARTY-NOTICES.md`，分发时必须保留。本项目原创部分为 MIT（见 `LICENSE`）。