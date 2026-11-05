# WorkBuddy2Codex

在 VS Code 里使用你已经登录的 WorkBuddy 账号里的模型，并把它们接进 Codex。

扩展在本地拉起一个零依赖的代理进程，把 WorkBuddy（国内版）已登录账号的模型
以 OpenAI 兼容接口暴露给 Codex；侧边栏负责启停、切换模型、查看剩余积分并写入
Codex 配置。整个过程无需申请 API Key，也不需要保持 WorkBuddy 桌面端运行。

```
VS Code 侧边栏  ──启动/停止──▶  proxy/proxy.mjs  ──▶  WorkBuddy 上游
      │                              ▲
      └──写入 config.toml + catalog──┘          Codex ──/v1/responses──▶ 本地代理
```

## 功能

- **一键启停**：侧边栏按钮或命令面板启动 / 停止 / 重启代理，不用开终端。
- **模型切换**：下拉框选模型，自动写入 Codex 的 `config.toml` 与模型目录。
- **剩余积分**：状态栏与面板实时显示 WorkBuddy 剩余积分及分包明细。
- **零配置凭据**：直接复用 WorkBuddy 桌面端已登录的凭据，过期前自动刷新。
- **零 npm 依赖**：只用 Node 内置模块与 `vscode` API。

> 仅支持 WorkBuddy **国内版**（`copilot.tencent.com` / `codebuddy.cn`）。

## 环境要求

- VS Code 1.85 或更高版本
- Node.js 18 或更高版本（扩展会优先使用设置里指定的 node，其次是 PATH）
- 本机已安装并登录 WorkBuddy 桌面端

## 安装

### 从 VSIX 安装

```powershell
npx @vscode/vsce package --no-dependencies
code --install-extension workbuddy2codex-1.0.0.vsix
```

### 从源码调试

```powershell
code F:\workbuddy2codex      # 打开本项目
# 按 F5 启动扩展开发宿主
```

也可以执行 `Developer: Install Extension from Location...` 并选择本项目根目录。

本项目不是 npm workspace，所有依赖都是 Node 内置模块，**不需要** `npm install`。
打包时请带上 `--no-dependencies`。

## 使用

1. 打开活动栏的 **WorkBuddy2Codex** 图标。
2. 点 **启动**。首次启动会读取 WorkBuddy 桌面端的登录凭据，之后在后台自动刷新，
   并把刷新结果缓存到 `~\.workbuddy2codex\auth.json`。**WorkBuddy 不需要保持运行。**
3. 在面板里选择模型，或执行命令 `WorkBuddy2Codex: 切换模型`。
4. 点 **写入 Codex**，扩展会把 provider 与模型目录写进 `~\.codex\config.toml`
   （写入前自动备份为 `config.toml.bak-w2c-<时间戳>`）。
5. **新开一个 Codex 会话**（或重启 Codex 扩展）使配置生效。

> 切换模型不做热加载：已经打开的 Codex 会话仍用旧模型，新会话才读取新配置。

## 命令

| 命令 | 说明 |
|---|---|
| `WorkBuddy2Codex: 启动代理` | 拉起本地代理并等待健康检查通过 |
| `WorkBuddy2Codex: 停止代理` | 停止代理进程 |
| `WorkBuddy2Codex: 重启代理` | 停止后重新启动 |
| `WorkBuddy2Codex: 切换模型` | QuickPick 选模型并写入 Codex 配置 |
| `WorkBuddy2Codex: 刷新剩余积分` | 立即查询一次积分 |
| `WorkBuddy2Codex: 写入 Codex 配置` | 写入 provider + catalog + 当前模型 |
| `WorkBuddy2Codex: 移除 Codex 配置` | 移除托管内容（先备份，可回滚） |
| `WorkBuddy2Codex: 打开 Codex 配置文件` | 在编辑器里打开 `config.toml` 核对 |

## 设置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `workbuddy2codex.port` | `8401` | 本地代理端口，Codex 的 `base_url` 使用它 |
| `workbuddy2codex.autoStart` | `true` | VS Code 启动时自动拉起代理 |
| `workbuddy2codex.nodePath` | 空 | 指定 node；留空自动查找 PATH / 常见安装目录 |
| `workbuddy2codex.codexConfigPath` | 空 | 留空使用 `~/.codex/config.toml`（或 `CODEX_HOME`） |
| `workbuddy2codex.creditsRefreshSeconds` | `60` | 积分刷新间隔（最小 15 秒） |
| `workbuddy2codex.proxyPath` | 空 | 高级：自定义 `proxy/proxy.mjs` 路径 |

## 写入的 Codex 配置

```toml
model = "<所选模型>"
model_provider = "workbuddy2codex"
model_catalog_json = "workbuddy2codex-catalog.json"

[model_providers.workbuddy2codex]
name = "WorkBuddy (local proxy)"
base_url = "http://127.0.0.1:8401/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "local"
```

`config.toml` 与 catalog 一律以 **UTF-8 无 BOM** 写入（Codex 遇到 BOM 会解析失败）。
写入是幂等的：重复执行不会产生重复段。`移除 Codex 配置` 会删掉该段并还原
你原来的 `model` / `model_provider` / `model_catalog_json`。

## 剩余积分

面板与状态栏显示的是 `POST /v2/billing/meter/get-user-resource` 的只读汇总：

- 月度包看 `CycleCapacityRemain`，一次性包看 `CapacityRemain`，过期或耗尽的
  一次性包不计入
- 企业账号走 `get-enterprise-user-usage`（`limitNum - credit`）
- 该接口不消耗积分

默认每 60 秒刷新，可用 `workbuddy2codex.creditsRefreshSeconds` 调整。

## 项目结构

```
workbuddy2codex/
├─ src/                      VS Code 扩展主体
│  ├─ extension.js           激活、命令、状态栏
│  ├─ controller.js          代理生命周期与状态聚合
│  ├─ proxy-process.js       子进程启动 / 停止
│  ├─ proxy-client.js        本地 HTTP 客户端
│  ├─ codex-config.js        config.toml 幂等写入与回滚
│  ├─ paths.js / node-locator.js / webview-html.js
│  └─ panel.js               Webview 视图提供者
├─ media/                    面板样式与脚本、活动栏图标
├─ proxy/                    代理运行时（扩展内置，随包分发）
│  ├─ proxy.mjs              Responses ↔ chat completions 双向翻译
│  └─ shared/                凭据、积分、模型目录
├─ dev/                      本地自检脚本
└─ package.json              扩展清单
```

代理只监听 `127.0.0.1`，由扩展按需拉起与停止，没有独立的命令行入口，
也没有开机自启、看门狗或第三方切换器集成。

## 开发自检

```powershell
npm run check      # 语法检查（扩展入口 + 代理）
npm run smoke      # 无 VS Code 环境下验证激活、命令注册与配置写入
npm run prepackage # 校验清单引用的文件都在仓库里
```

`smoke` 与 `prepackage` 会把 Codex 配置写到临时目录，不会改动你真实的
`~/.codex/config.toml`。

## 故障排查

| 现象 | 处理 |
|---|---|
| 面板提示「找不到 proxy/proxy.mjs」 | 确认 `proxy/proxy.mjs` 存在，或设置 `workbuddy2codex.proxyPath` |
| 启动失败、日志为空 | 检查 `workbuddy2codex.nodePath`；VS Code 自带的 Electron 运行时也能兜底 |
| 401 / 刷新失败 | 打开 WorkBuddy 桌面端点一次「登录」；扩展会重新读取凭据 |
| 402 / 积分不足 | 面板积分见底，需在 WorkBuddy 侧充值 |
| 429 | 上游限流，稍后重试 |
| Codex 里看不到模型 | 确认已点「写入 Codex」，并**新开** Codex 会话 |
| 端口被占 | 换一个 `workbuddy2codex.port`；插件只接管自己拉起的进程 |

日志位置：`~\.workbuddy2codex\proxy-<port>.log`（面板底部也会显示末尾几行）。

## 已知限制

- 只监听 `127.0.0.1`，不对局域网开放
- 代理进程崩溃后不会自动重启，需要手动重启
- 上游按积分计费，倍率随模型不同
- 依赖非官方接口，上游协议变更即可能失效
- 支持的模型目录来自上游实时拉取，失败时回落到内置表

## 法律与合规提示

- WorkBuddy 是腾讯的闭源商业软件，受其服务条款约束。本项目通过非官方接口
  访问，可能违反其 ToS；使用前请自行评估。
- 请只用于**你自己账号**的本机调用，不要用于批量、转售或规避计费。
- 本项目**不绕过付费**：所有调用仍然消耗你自己账号的积分。
- 作者不对因使用本项目导致的账号封禁、积分损失或任何其他后果负责。

## License

原创部分：MIT，© 2026 Black Yuan，详见 `LICENSE`。

`proxy/` 中有部分实现移植自 MIT 许可的 `dsh-workbuddy-connect`，
其署名与许可原文见 `THIRD-PARTY-NOTICES.md`，
分发时必须保留。
