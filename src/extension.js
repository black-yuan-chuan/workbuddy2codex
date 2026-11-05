"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const { ProxyController } = require("./controller");
const { PanelViewProvider } = require("./panel");
const codex = require("./codex-config");

let controller = null;
let statusItem = null;

function config() {
  return vscode.workspace.getConfiguration("workbuddy2codex");
}

function formatTotal(credits) {
  if (!credits || !Number.isFinite(Number(credits.total))) return "—";
  return String(Math.round(Number(credits.total) * 100) / 100);
}

function renderStatus(snapshot) {
  if (!statusItem) return;
  const running = snapshot?.running;
  statusItem.text = `$(plug) WB ${formatTotal(snapshot?.credits)}`;
  statusItem.color = running ? undefined : new vscode.ThemeColor("statusBarItem.warningForeground");
  statusItem.tooltip = running
    ? `WorkBuddy2Codex 运行中（端口 ${snapshot.port}）\n剩余积分：${formatTotal(snapshot.credits)}\n点击打开面板`
    : "WorkBuddy2Codex 未启动，点击启动面板";
  statusItem.command = "workbuddy2codex.showPanel";
}

/** 模型选择：优先 QuickPick，也接受面板直接传入的 id。 */
async function selectModel(modelId) {
  if (!controller.running) {
    const action = await vscode.window.showWarningMessage("代理未启动，先启动后才能获取可用模型。", "启动");
    if (action === "启动") await controller.start();
  }
  let target = modelId;
  if (!target) {
    const items = controller.models.map((model) => ({
      label: model.displayName || model.id,
      description: model.creditMultiplier != null ? `x${model.creditMultiplier}` : "",
      detail: `${model.id} · 上下文 ${Math.round((model.ctx || 0) / 1000)}K`,
      id: model.id,
    }));
    if (!items.length) {
      vscode.window.showErrorMessage("没有可用模型：请确认 WorkBuddy 已登录且代理运行正常。");
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "切换 WorkBuddy 模型",
      placeHolder: controller.selectedModel || "选择模型",
    });
    if (!picked) return;
    target = picked.id;
  }
  const result = await controller.selectModel(target);
  vscode.window.showInformationMessage(
    `已切换为 ${target}，配置写入 ${result.configPath}。需要新开 Codex 会话（或重启 Codex 扩展）才生效。`
  );
}

async function startProxy() {
  try {
    await controller.start();
  } catch (err) {
    const detail = vscode.window.showErrorMessage(`启动失败：${String(err?.message ?? err)}`, "查看日志");
    if (detail === "查看日志") await vscode.commands.executeCommand("workbuddy2codex.showPanel");
  }
}

async function stopProxy() {
  const result = await controller.stop();
  if (result.stopped) vscode.window.showInformationMessage("WorkBuddy2Codex 代理已停止");
  else vscode.window.showInformationMessage("代理本来就没有运行");
}

async function restartProxy() {
  await controller.restart();
  vscode.window.showInformationMessage("WorkBuddy2Codex 代理已重启");
}

async function refreshCredits() {
  if (!controller.running) {
    vscode.window.showWarningMessage("代理未启动，无法查询积分。");
    return;
  }
  const credits = await controller.refreshCredits();
  if (credits) {
    vscode.window.showInformationMessage(`WorkBuddy 剩余积分：${formatTotal(credits)}`);
  }
}

async function syncCodexConfig() {
  const model = controller.selectedModel || controller.models[0]?.id;
  if (!model) {
    vscode.window.showErrorMessage("请先启动代理并选择模型。");
    return;
  }
  const result = await controller.syncCodex(model);
  vscode.window.showInformationMessage(
    `已写入 ${result.configPath}${result.backupPath ? `（备份：${result.backupPath}）` : ""}`
  );
}

async function removeCodexConfig() {
  const confirmed = await vscode.window.showWarningMessage(
    "移除插件写入的 Codex provider 与模型目录？config.toml 会先备份。",
    { modal: true },
    "移除"
  );
  if (confirmed !== "移除") return;
  const result = await controller.removeCodex();
  vscode.window.showInformationMessage(
    result.removed ? `已移除，备份：${result.backupPath}` : "没有找到 Codex 配置，无需移除"
  );
}

async function openCodexConfig() {
  const file = codex.configPath(config().get("codexConfigPath", ""));
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage(`Codex 配置还不存在：${file}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function showPanel() {
  await vscode.commands.executeCommand("workbuddy2codex.panel.focus");
}

function registerCommands(context) {
  const table = {
    "workbuddy2codex.start": startProxy,
    "workbuddy2codex.stop": stopProxy,
    "workbuddy2codex.restart": restartProxy,
    "workbuddy2codex.selectModel": selectModel,
    "workbuddy2codex.refreshCredits": refreshCredits,
    "workbuddy2codex.syncCodexConfig": syncCodexConfig,
    "workbuddy2codex.removeCodexConfig": removeCodexConfig,
    "workbuddy2codex.openCodexConfig": openCodexConfig,
    "workbuddy2codex.showPanel": showPanel,
  };
  for (const [id, handler] of Object.entries(table)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

async function activate(context) {
  controller = new ProxyController(context);
  context.subscriptions.push(controller.onDidChange.event((snapshot) => renderStatus(snapshot)));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.show();
  context.subscriptions.push(statusItem);

  const provider = new PanelViewProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("workbuddy2codex.panel", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(provider);
  context.subscriptions.push(controller);
  registerCommands(context);

  await controller.refreshStatus();
  renderStatus(controller.snapshot());
  controller.startPolling();
  if (controller.running) {
    await controller.refreshModels();
    await controller.refreshCredits();
  } else if (config().get("autoStart", true)) {
    try {
      await controller.start({ silent: true });
    } catch (err) {
      vscode.window.showWarningMessage(`WorkBuddy2Codex 自动启动失败：${String(err?.message ?? err)}`);
    }
  }
  await controller.saveSnapshot();
}

function deactivate() {
  if (controller) {
    controller.stopPolling();
    controller.dispose?.();
    controller = null;
  }
  statusItem = null;
}

module.exports = { activate, deactivate };
