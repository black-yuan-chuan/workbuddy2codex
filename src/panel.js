"use strict";

const vscode = require("vscode");
const { renderHtml } = require("./webview-html");

class PanelViewProvider {
  constructor(context, controller) {
    this.context = context;
    this.controller = controller;
    this.view = null;
    this.disposable = controller.onDidChange.event(() => this.render());
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const root = vscode.Uri.joinPath(this.context.extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [root] };
    webviewView.webview.html = renderHtml(webviewView.webview, root);
    webviewView.webview.onDidReceiveMessage((message) => this.handle(message));
    webviewView.onDidDispose(() => {
      this.view = null;
    });
    this.render();
  }

  render() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: "state", state: this.controller.snapshot() });
  }

  async handle(message) {
    try {
      switch (message?.command) {
        case "ready":
          this.render();
          break;
        case "start":
          await this.controller.start();
          break;
        case "stop":
          await this.controller.stop();
          break;
        case "restart":
          await this.controller.restart();
          break;
        case "selectModel":
          await vscode.commands.executeCommand("workbuddy2codex.selectModel", message.model);
          break;
        case "refreshCredits":
          await this.controller.refreshCredits();
          break;
        case "syncCodex":
          await vscode.commands.executeCommand("workbuddy2codex.syncCodexConfig");
          break;
        case "openConfig":
          await vscode.commands.executeCommand("workbuddy2codex.openCodexConfig");
          break;
        default:
          break;
      }
    } catch (err) {
      vscode.window.showErrorMessage(`WorkBuddy2Codex：${String(err?.message ?? err)}`);
      this.render();
    }
  }

  dispose() {
    this.disposable.dispose();
  }
}

module.exports = { PanelViewProvider };
