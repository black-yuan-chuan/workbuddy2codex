"use strict";

const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { ensureStateDir, pidFile, logFile } = require("./paths");
const { locateNode } = require("./node-locator");

const isWindows = process.platform === "win32";

/** 通过 pid 文件识别仍在运行的本插件代理。 */
function readPid(port) {
  try {
    const raw = fs.readFileSync(pidFile(port), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    // pid 可能被系统复用：只认命令行里确实跑着 proxy.mjs 的进程。
    return isProxyProcess(pid) ? pid : null;
  } catch {
    return null;
  }
}

function commandLineOf(pid) {
  if (!isWindows) {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return "";
    }
  }
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
  } catch {
    return "";
  }
}

function isProxyProcess(pid) {
  return /proxy\.mjs/i.test(commandLineOf(pid));
}

function clearPid(port) {
  try {
    fs.unlinkSync(pidFile(port));
  } catch {}
}

function killTree(pid) {
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/** 启动代理进程（脱离 VS Code 生命周期，关闭窗口后仍在跑）。 */
function spawnProxy(options) {
  const { script, configuredNode, port } = options;
  const node = locateNode(configuredNode);
  ensureStateDir();
  const out = fs.openSync(logFile(port), "a");
  fs.writeSync(out, `\n[extension] start ${new Date().toISOString()} port=${port}\n`);
  const child = spawn(node.command, [script], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ...node.env,
      PORT: String(port),
    },
  });
  child.unref();
  fs.writeFileSync(pidFile(port), String(child.pid), "utf8");
  fs.closeSync(out);
  return child.pid;
}

/** 停止代理：结束整个进程树并清掉 pid 记录。 */
function stopProxy(port) {
  const pid = readPid(port);
  if (!pid) return { stopped: false, reason: "not-running" };
  const ok = killTree(pid);
  clearPid(port);
  return { stopped: ok, pid };
}

module.exports = { readPid, clearPid, spawnProxy, stopProxy };
