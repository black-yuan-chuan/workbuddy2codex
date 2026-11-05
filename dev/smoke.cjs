#!/usr/bin/env node
/**
 * 无 VS Code 环境下的冒烟测试：用最小 vscode 桩 require 扩展入口，
 * 验证激活流程、命令注册与 Codex 配置写入（写到临时目录）。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const commands = new Map();
const messages = [];
const registeredViews = new Map();

const vscodeStub = {
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    joinPath: (base, name) => ({ fsPath: path.join(base.fsPath, name) }),
    file: (file) => ({ fsPath: file }),
  },
  window: {
    createStatusBarItem: () => ({
      show() {},
      hide() {},
      dispose() {},
    }),
    registerWebviewViewProvider: (id, provider) => {
      registeredViews.set(id, provider);
      return { dispose() {} };
    },
    showInformationMessage: async (...args) => messages.push(["info", args[0]]) && undefined,
    showWarningMessage: async (...args) => messages.push(["warn", args[0]]) && undefined,
    showErrorMessage: async (...args) => messages.push(["error", args[0]]) && undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => {
        if (key === "autoStart") return false;
        return fallback;
      },
    }),
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose: () => commands.delete(id) };
    },
    executeCommand: async (id) => {
      const handler = commands.get(id);
      if (!handler) throw new Error(`command not registered: ${id}`);
      return handler();
    },
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "w2c-smoke-"));
process.env.CODEX_HOME = tmpHome;
fs.writeFileSync(
  path.join(tmpHome, "config.toml"),
  ['model = "gpt-5.1-codex"', 'model_provider = "openai"', "", "[projects.'f:\\demo-project']", 'trust_level = "trusted"', ""].join("\n"),
  "utf8"
);

const codex = require("../src/codex-config.js");
const extension = require("../src/extension.js");

(async () => {
  const context = {
    extensionPath: path.join(__dirname, ".."),
    extensionUri: { fsPath: path.join(__dirname, "..") },
    subscriptions: [],
    globalState: {
      store: new Map(),
      get(key, fallback) { return this.store.has(key) ? this.store.get(key) : fallback; },
      async update(key, value) { this.store.set(key, value); },
    },
  };

  await extension.activate(context);
  assert.ok(registeredViews.has("workbuddy2codex.panel"), "webview view provider registered");
  for (const id of [
    "workbuddy2codex.start",
    "workbuddy2codex.stop",
    "workbuddy2codex.restart",
    "workbuddy2codex.selectModel",
    "workbuddy2codex.refreshCredits",
    "workbuddy2codex.syncCodexConfig",
    "workbuddy2codex.removeCodexConfig",
    "workbuddy2codex.openCodexConfig",
    "workbuddy2codex.showPanel",
  ]) {
    assert.ok(commands.has(id), `command registered: ${id}`);
  }

  const result = codex.syncCodexConfig({
    model: "glm-5.3-flash",
    port: 8401,
    catalog: { models: [{ slug: "glm-5.3-flash" }] },
  });
  const toml = fs.readFileSync(result.configPath, "utf8");
  assert.match(toml, /^model\s*=\s*"glm-5\.3-flash"$/m);
  assert.match(toml, /^model_provider\s*=\s*"workbuddy2codex"$/m);
  assert.match(toml, /^model_catalog_json\s*=\s*"workbuddy2codex-catalog\.json"$/m);
  assert.match(toml, /\[model_providers\.workbuddy2codex\]/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:8401\/v1"/);
  assert.match(toml, /\[projects\.'f:\\demo-project'\]/, "project section preserved");
  assert.ok(!/\uFEFF/.test(toml), "config has no BOM");
  assert.ok(!toml.includes("\r\n"), "config uses LF endings");
  assert.ok(result.backupPath && fs.existsSync(result.backupPath), "config backed up");
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(result.catalogPath, "utf8"))), ["models"]);

  const again = codex.syncCodexConfig({ model: "hy3", port: 8401, catalog: { models: [] } });
  const twice = fs.readFileSync(again.configPath, "utf8");
  assert.strictEqual(twice.match(/\[model_providers\.workbuddy2codex\]/g).length, 1, "provider section is idempotent");
  assert.match(twice, /^model\s*=\s*"hy3"$/m);

  const removed = codex.removeCodexConfig({});
  const after = fs.readFileSync(removed.configPath, "utf8");
  assert.ok(!after.includes("workbuddy2codex"), "provider removed");
  assert.match(after, /^model\s*=\s*"gpt-5\.1-codex"$/m);
  assert.match(after, /^model_provider\s*=\s*"openai"$/m, "original provider restored");
  assert.match(after, /\[projects\.'f:\\demo-project'\]/, "project section survived removal");

  extension.deactivate();
  console.log(`smoke ok: commands=${commands.size} views=${registeredViews.size} codexHome=${tmpHome}`);
  console.log("messages:", messages.length ? JSON.stringify(messages) : "(none)");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
