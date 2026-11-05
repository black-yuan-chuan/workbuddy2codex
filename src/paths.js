"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 插件私有状态目录（pid、日志、Codex 目录快照）。 */
function stateDir() {
  return path.join(os.homedir(), ".workbuddy2codex");
}

function ensureStateDir() {
  fs.mkdirSync(stateDir(), { recursive: true });
  return stateDir();
}

/** 依次尝试：用户配置 → 扩展自带代理。 */
function locateProxyScript(extensionPath, configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(path.join(extensionPath, "proxy", "proxy.mjs"));
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return path.resolve(file);
    } catch {}
  }
  return null;
}

function pidFile(port) {
  return path.join(stateDir(), `proxy-${port}.pid`);
}

function logFile(port) {
  return path.join(stateDir(), `proxy-${port}.log`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  ensureStateDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

/** 读日志尾部，用于 UI 与启动失败诊断。 */
function tailLog(port, maxLines = 60) {
  try {
    const text = fs.readFileSync(logFile(port), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

module.exports = {
  stateDir,
  ensureStateDir,
  locateProxyScript,
  pidFile,
  logFile,
  readJson,
  writeJson,
  tailLog,
};
