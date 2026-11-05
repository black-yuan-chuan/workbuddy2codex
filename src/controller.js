"use strict";

const vscode = require("vscode");
const { locateProxyScript, tailLog, readJson, writeJson, stateDir } = require("./paths");
const { readPid, spawnProxy, stopProxy } = require("./proxy-process");
const client = require("./proxy-client");
const codex = require("./codex-config");

const STATE_FILE = "state.json";
const MODEL_KEY = "workbuddy2codex.model";

function config() {
  return vscode.workspace.getConfiguration("workbuddy2codex");
}

/** 只有带新接口的实例才能接管；缺 /v1/credits 或 /w2c/* 一律视为不兼容。 */
function isCompatible(health) {
  const endpoints = Array.isArray(health?.endpoints) ? health.endpoints : [];
  return endpoints.includes("/v1/credits") && endpoints.includes("/w2c/models");
}

/**
 * 代理生命周期 + 状态聚合。所有 UI（状态栏/面板）只读 snapshot()。
 */
class ProxyController {
  constructor(context) {
    this.context = context;
    this.onDidChange = new vscode.EventEmitter();
    this.running = false;
    this.pid = null;
    this.health = null;
    this.models = [];
    this.credits = null;
    this.error = "";
    this.lastUpdated = 0;
    this.busy = "";
    this.timer = null;
    this.polling = false;
  }

  get port() {
    return Number(config().get("port", 8401)) || 8401;
  }

  get script() {
    return locateProxyScript(this.context.extensionPath, config().get("proxyPath", ""));
  }

  get selectedModel() {
    return this.context.globalState.get(MODEL_KEY, "");
  }

  snapshot() {
    return {
      running: this.running,
      pid: this.pid,
      port: this.port,
      models: this.models,
      selectedModel: this.selectedModel,
      credits: this.credits,
      error: this.error,
      busy: this.busy,
      updatedAt: this.lastUpdated,
      script: this.script,
      codexConfig: codex.configPath(config().get("codexConfigPath", "")),
      logs: tailLog(this.port, 40),
    };
  }

  emit() {
    this.onDidChange.fire(this.snapshot());
  }

  async start({ silent = false } = {}) {
    if (this.running) return true;
    this.busy = "start";
    this.error = "";
    this.emit();
    // 端口上已有本插件拉起的代理时直接接管，避免重复启动。
    try {
      this.health = await client.health(this.port);
      if (isCompatible(this.health) && readPid(this.port)) {
        this.running = true;
        this.pid = readPid(this.port);
        this.error = "";
        await this.refreshModels();
        await this.refreshCredits();
        this.emit();
        return true;
      }
    } catch {
    } finally {
      if (this.running) this.busy = "";
    }
    const script = this.script;
    if (!script) {
      this.error = "找不到 proxy/proxy.mjs；请在设置中指定 workbuddy2codex.proxyPath";
      this.busy = "";
      this.emit();
      throw new Error(this.error);
    }
    try {
      const pid = spawnProxy({ script, configuredNode: config().get("nodePath", ""), port: this.port });
      this.pid = pid;
      await this.waitHealthy(20);
      this.running = true;
      this.error = "";
      if (!silent) vscode.window.showInformationMessage(`WorkBuddy2Codex 代理已启动（端口 ${this.port}）`);
      await this.refreshModels();
      await this.refreshCredits();
      return true;
    } catch (err) {
      this.running = false;
      this.error = `启动失败：${String(err?.message ?? err)}`;
      throw err;
    } finally {
      this.busy = "";
      this.emit();
    }
  }

  async waitHealthy(attempts) {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      try {
        this.health = await client.health(this.port);
        return this.health;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastErr ?? new Error("health check failed");
  }

  async stop() {
    this.busy = "stop";
    this.emit();
    try {
      const result = stopProxy(this.port);
      this.running = false;
      this.pid = null;
      this.health = null;
      this.models = [];
      this.credits = null;
      return result;
    } finally {
      this.busy = "";
      this.emit();
    }
  }

  async restart() {
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return this.start();
  }

  async refreshStatus() {
    const pid = readPid(this.port);
    this.pid = pid;
    if (!pid) {
      this.running = false;
      this.health = null;
      this.models = [];
      this.credits = null;
      this.emit();
      return;
    }
    try {
      this.health = await client.health(this.port);
      this.running = isCompatible(this.health);
      this.error = this.running ? "" : "代理接口不匹配，请点『重启代理』升级";
    } catch (err) {
      this.running = false;
      this.error = `代理无响应：${String(err?.message ?? err)}`;
    }
    this.emit();
  }

  async refreshModels() {
    if (!this.running) return this.models;
    try {
      const doc = await client.models(this.port);
      this.models = Array.isArray(doc.models) ? doc.models : [];
      this.error = "";
      await this.ensureManagedCatalog();
    } catch (err) {
      this.error = `模型目录获取失败：${String(err?.message ?? err)}`;
    }
    this.emit();
    return this.models;
  }

  async refreshCredits() {
    if (!this.running) return null;
    try {
      this.credits = await client.credits(this.port);
      this.lastUpdated = Date.now();
      this.error = "";
    } catch (err) {
      this.credits = null;
      this.error = `积分查询失败：${String(err?.message ?? err)}`;
    }
    this.emit();
    return this.credits;
  }

  /** 已接管 config 时，模型目录变化要同步给 Codex。 */
  async ensureManagedCatalog() {
    const cfg = codex.configPath(config().get("codexConfigPath", ""));
    if (!/^\s*model_provider\s*=\s*"workbuddy2codex"/m.test(codex.readConfig(cfg))) return;
    try {
      const catalog = await client.catalog(this.port);
      codex.writeTextNoBom(codex.catalogPath(cfg), JSON.stringify(catalog, null, 2));
    } catch {}
  }

  /** 切模型：写 Codex 配置，需要新会话才生效。 */
  async selectModel(modelId) {
    if (!modelId) return null;
    if (!this.running) await this.start({ silent: true });
    this.busy = "model";
    this.emit();
    try {
      const catalog = this.running ? await client.catalog(this.port) : null;
      const result = codex.syncCodexConfig({
        model: modelId,
        port: this.port,
        configuredPath: config().get("codexConfigPath", ""),
        catalog,
      });
      await this.context.globalState.update(MODEL_KEY, modelId);
      return result;
    } finally {
      this.busy = "";
      this.emit();
    }
  }

  async syncCodex(modelId) {
    // 目录必须真实存在，Codex 才会启动；没运行就先拉起代理再取一次。
    if (!this.running) await this.start({ silent: true });
    const catalog = this.running ? await client.catalog(this.port) : null;
    const result = codex.syncCodexConfig({
      model: modelId || this.selectedModel || this.models[0]?.id || "glm-5.3-flash",
      port: this.port,
      configuredPath: config().get("codexConfigPath", ""),
      catalog,
    });
    if (result.changed) this.emit();
    return result;
  }

  async removeCodex() {
    const result = codex.removeCodexConfig({ configuredPath: config().get("codexConfigPath", "") });
    this.emit();
    return result;
  }

  startPolling() {
    this.stopPolling();
    const seconds = Math.max(15, Number(config().get("creditsRefreshSeconds", 60)) || 60);
    this.timer = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        await this.refreshStatus();
        if (this.running) await this.refreshCredits();
      } catch {
      } finally {
        this.polling = false;
      }
    }, seconds * 1000);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async saveSnapshot() {
    try {
      writeJson(`${stateDir()}/${STATE_FILE}`, { port: this.port, selectedModel: this.selectedModel, savedAt: Date.now() });
    } catch {}
  }

  readSnapshot() {
    return readJson(`${stateDir()}/${STATE_FILE}`);
  }

  dispose() {
    this.stopPolling();
    this.onDidChange.dispose();
  }
}

module.exports = { ProxyController, MODEL_KEY };
