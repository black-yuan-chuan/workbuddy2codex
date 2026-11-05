"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROVIDER_ID = "workbuddy2codex";
const CATALOG_FILENAME = "workbuddy2codex-catalog.json";
const MANAGED_KEYS = ["model", "model_provider", "model_catalog_json"];

function codexHome() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(os.homedir(), ".codex");
}

function configPath(configured) {
  if (configured && configured.trim()) return configured.trim();
  return path.join(codexHome(), "config.toml");
}

function catalogPath(cfgPath) {
  return path.join(path.dirname(cfgPath), CATALOG_FILENAME);
}

/** 与 config.toml 同目录，避免多份 CODEX_HOME 互相覆盖。 */
function originalStatePath(cfgPath) {
  return path.join(path.dirname(cfgPath), ".workbuddy2codex-original.json");
}

/** UTF-8 no BOM：Codex 解析到 BOM 会直接报错。 */
function writeTextNoBom(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: "utf8", flag: "w" });
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = `${file}.bak-w2c-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

function readConfig(cfgPath) {
  try {
    return fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/** 定位 `[model_providers.x]` 段并在其末尾插入/替换键值。 */
function upsertProviderSection(toml, port) {
  const header = `[model_providers.${PROVIDER_ID}]`;
  const lines = toml.split(/\r?\n/);
  const body = [
    `name = "WorkBuddy (local proxy)"`,
    `base_url = "http://127.0.0.1:${port}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `experimental_bearer_token = "local"`,
  ];
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const block = ["", header, ...body];
    return `${toml.replace(/\s*$/, "")}\n${block.join("\n")}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return [...before, ...body, ...after].join("\n");
}

function stripProviderSection(toml) {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[model_providers.${PROVIDER_ID}]`);
  if (start === -1) return toml;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** 只改顶层标量键，避免误伤 `[projects]` 里的同名键。 */
function setTopLevel(toml, key, value) {
  const lines = toml.split(/\r?\n/);
  let firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstSection === -1) firstSection = lines.length;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < firstSection; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join("\n");
    }
  }
  lines.splice(firstSection, 0, `${key} = ${value}`);
  return lines.join("\n");
}

function removeTopLevel(toml, key) {
  const lines = toml.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstSection === -1) firstSection = lines.length;
  for (let i = 0; i < firstSection; i += 1) {
    if (pattern.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return toml;
}

/** 统一换行与结尾，避免重复写入导致文件越来越空/越来越长。 */
function normalizeToml(toml) {
  return `${toml.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

function readCurrentModel(cfgPath) {
  const toml = readConfig(configPath(cfgPath));
  const match = /^\s*model\s*=\s*"([^"]*)"/m.exec(toml);
  return match ? match[1] : "";
}

/** 读取顶层字符串键；不存在返回 null。 */
function readTopLevel(toml, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return match ? match[1] : null;
}

function isManaged(toml) {
  return /^\s*model_provider\s*=\s*"workbuddy2codex"/m.test(toml);
}

function readOriginalState() {
  return readOriginalStateFor(configPath());
}

function readOriginalStateFor(cfg) {
  try {
    return JSON.parse(fs.readFileSync(originalStatePath(cfg), "utf8"));
  } catch {
    return null;
  }
}

/** 首次接管前保存用户原有顶层值，便于 --remove 时精确回滚。 */
function rememberOriginal(cfg, toml) {
  if (isManaged(toml)) return;
  const saved = { savedAt: Date.now() };
  for (const key of MANAGED_KEYS) saved[key] = readTopLevel(toml, key);
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  writeTextNoBom(originalStatePath(cfg), JSON.stringify(saved, null, 2));
}

function applyOriginal(toml, saved) {
  for (const key of MANAGED_KEYS) {
    const value = saved?.[key];
    toml = value === null || value === undefined
      ? removeTopLevel(toml, key)
      : setTopLevel(toml, key, `"${value}"`);
  }
  return toml;
}

/** 写 catalog + provider 段 + 顶层 model，返回变更摘要。 */
function syncCodexConfig({ model, port, configuredPath, catalog }) {
  const cfg = configPath(configuredPath);
  const existed = fs.existsSync(cfg);
  const before = readConfig(cfg);
  const backupPath = backup(cfg);
  rememberOriginal(cfg, before);
  let toml = upsertProviderSection(before, port);
  toml = setTopLevel(toml, "model_provider", `"${PROVIDER_ID}"`);
  toml = setTopLevel(toml, "model_catalog_json", `"${CATALOG_FILENAME}"`);
  if (model) toml = setTopLevel(toml, "model", `"${model}"`);
  const cat = catalogPath(cfg);
  // 没有目录文件时 Codex 会拒绝启动：先确认目录能落盘，再改 config.toml。
  if (!catalog && !fs.existsSync(cat)) {
    throw new Error(`模型目录尚未生成：${cat}（请先启动代理并重试）`);
  }
  writeTextNoBom(cfg, normalizeToml(toml));
  if (catalog) writeTextNoBom(cat, JSON.stringify(catalog, null, 2));
  return { configPath: cfg, catalogPath: cat, backupPath, created: !existed, changed: before !== toml };
}

/** 移除托管内容；`model` 回退到调用方给的默认值（通常是 Codex 原生模型）。 */
function removeCodexConfig({ configuredPath }) {
  const cfg = configPath(configuredPath);
  if (!fs.existsSync(cfg)) return { removed: false, reason: "no-config" };
  const backupPath = backup(cfg);
  let toml = stripProviderSection(readConfig(cfg));
  toml = applyOriginal(toml, readOriginalStateFor(cfg));
  writeTextNoBom(cfg, normalizeToml(toml));
  try {
    fs.unlinkSync(catalogPath(cfg));
  } catch {}
  try {
    fs.unlinkSync(originalStatePath(cfg));
  } catch {}
  return { removed: true, backupPath, configPath: cfg };
}

module.exports = {
  PROVIDER_ID,
  CATALOG_FILENAME,
  MANAGED_KEYS,
  codexHome,
  configPath,
  catalogPath,
  readConfig,
  readCurrentModel,
  syncCodexConfig,
  removeCodexConfig,
  writeTextNoBom,
};
