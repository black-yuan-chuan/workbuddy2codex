"use strict";

const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { ensureStateDir, pidFile, logFile } = require("./paths");
const { locateNode } = require("./node-locator");

const isWindows = process.platform === "win32";

/** 进程是否还活着（signal 0 只做存在性探测）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 命令行里是否有以 proxy.mjs 结尾的参数（旧版本装在不同目录下也算）。 */
function isProxyCommand(command) {
  if (!command) return false;
  return String(command)
    .split(/["'\s]+/)
    .some((token) => /[\\/]proxy\.mjs$/i.test(token));
}

/** 读出进程命令行；进程不存在或读取失败时返回空串。 */
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
  return isProxyCommand(commandLineOf(pid));
}

function windowsPortOwner(port) {
  const script =
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
    "| Select-Object -First 1 -ExpandProperty OwningProcess";
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return Number.parseInt(String(out).trim(), 10) || null;
}

function unixPortOwner(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return Number.parseInt(String(out).split(/\s+/).filter(Boolean)[0], 10) || null;
  } catch {
    return null;
  }
}

/** 端口监听者 pid；端口空闲时返回 null。 */
function portOwnerPid(port) {
  try {
    return isWindows ? windowsPortOwner(port) : unixPortOwner(port);
  } catch {
    return null;
  }
}

/** 端口占用者信息：{ pid, command }；端口空闲返回 null。 */
function portOwner(port) {
  const pid = portOwnerPid(port);
  if (!pid) return null;
  return { pid, command: commandLineOf(pid).trim() };
}

/** pid 文件里登记且确实还在跑的代理。 */
function recordedPid(port) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(port), "utf8").trim(), 10);
    if (!isAlive(pid) || !isProxyProcess(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * 识别本插件的代理进程。
 *
 * 优先信任 pid 文件；pid 文件缺失或指向已退出的进程时（旧版本遗留、
 * 手工 kill 后重启 VS Code 等），退化为检查端口真实监听者的命令行，
 * 认出来就顺手把 pid 文件修正过来，避免“代理在跑但插件说没跑”。
 */
function readPid(port) {
  const recorded = recordedPid(port);
  if (recorded) return recorded;
  const owner = portOwner(port);
  if (!owner || !isProxyCommand(owner.command)) return null;
  try {
    ensureStateDir();
    fs.writeFileSync(pidFile(port), String(owner.pid), "utf8");
  } catch {}
  return owner.pid;
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
  if (!pid) {
    clearPid(port);
    return { stopped: false, reason: "not-running" };
  }
  const ok = killTree(pid);
  clearPid(port);
  return { stopped: ok, pid };
}

module.exports = { isAlive, isProxyCommand, readPid, clearPid, portOwner, spawnProxy, stopProxy };