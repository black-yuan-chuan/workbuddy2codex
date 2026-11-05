"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isWindows = process.platform === "win32";
const NODE_NAMES = isWindows ? ["node.exe"] : ["node"];

function isNodeBinary(candidate) {
  const base = path.basename(candidate).toLowerCase();
  return base === "node.exe" || base === "node";
}

function uniqueExisting(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    if (!file) continue;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(file).isFile()) out.push(file);
    } catch {}
  }
  return out;
}

function pathCandidates() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => NODE_NAMES.map((name) => path.join(dir, name)));
}

function wellKnownCandidates() {
  if (!isWindows) return ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"];
  const bases = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), "AppData", "Local"),
  ].filter(Boolean);
  return bases.map((base) => path.join(base, "nodejs", "node.exe"));
}

/**
 * 返回 { command, env }。
 * 找不到独立 node 时退回 Electron 的 node 模式（VS Code 自带运行时）。
 */
function locateNode(configured) {
  const explicit = configured && configured.trim() ? [configured.trim()] : [];
  const found = uniqueExisting([...explicit, ...pathCandidates(), ...wellKnownCandidates()]);
  if (found.length) return { command: found[0], env: {} };
  if (isNodeBinary(process.execPath)) return { command: process.execPath, env: {} };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

module.exports = { locateNode };
