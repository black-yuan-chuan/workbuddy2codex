/**
 * WorkBuddy 凭据读取与刷新（国内版）。
 *
 * 凭据来源优先级：
 *   1. 桌面 App 的 auth 文件（明文或 at-rest 加密信封，均支持）
 *   2. 本地已刷新的副本，避免 App 退出后立刻失效
 *
 * 关键点：读取加密信封只需要 App 的**可执行文件**，不需要 App 在运行；
 * atrest.mjs 用 ELECTRON_RUN_AS_NODE 跑一个短命子进程取密钥。
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { parseAuthDocWithDecrypt } from "./atrest.mjs";

export const CN_CHAT_BASE = "https://copilot.tencent.com";
export const CN_BILLING_BASE = "https://www.codebuddy.cn";
export const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
export const AUTH_FILENAME = "workbuddy-desktop.info";
export const REFRESH_MARGIN_MS = 5 * 60_000;
const JSON_TIMEOUT_MS = 30_000;

/** 桌面 App 写凭据的位置（按平台）。 */
export function desktopAuthCandidates() {
  if (platform() === "win32") {
    return [
      join(homedir(), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME),
      join(homedir(), "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME),
    ];
  }
  if (platform() === "darwin") {
    return [join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME)];
  }
  return [join(homedir(), ".config", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME)];
}

/** 代理自己保存刷新结果的副本（不写回 App 的文件）。 */
export function ownCredentialPath(home = homedir()) {
  return join(home, ".workbuddy2codex", "auth.json");
}

const expiryToMs = (v) => (!Number.isFinite(v) || v <= 0 ? 0 : v > 1e12 ? v : v * 1e3);

/** 明文 auth 文档 → 凭据。 */
export function parseAuthDoc(text) {
  const parsed = JSON.parse(text);
  const auth = parsed.auth ?? parsed;
  const identity = parsed.account ?? parsed;
  if (typeof auth.accessToken !== "string" || auth.accessToken === "") throw new Error("auth doc has no accessToken");
  return {
    accessToken: auth.accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: typeof auth.domain === "string" ? auth.domain : "",
    uid: typeof identity.uid === "string" ? identity.uid : "",
    enterpriseId: typeof identity.enterpriseId === "string" ? identity.enterpriseId : "",
  };
}

/** 明文与加密信封都接受。 */
export async function parseAuthDocAuto(text) {
  const parsed = JSON.parse(text);
  const auth = parsed.auth ?? parsed;
  if (auth && typeof auth.accessToken === "object" && auth.accessToken !== null) {
    return parseAuthDocWithDecrypt(parsed);
  }
  return parseAuthDoc(text);
}

/** 凭据是否已过期（或即将过期）。 */
export function needsRefresh(cred, now = Date.now()) {
  return cred.expiresAtMs > 0 && now + REFRESH_MARGIN_MS >= cred.expiresAtMs;
}

export function isExpired(cred, now = Date.now()) {
  return cred.expiresAtMs > 0 && now >= cred.expiresAtMs;
}

/** 调用上游刷新 token。 */
export async function refreshCredential(cred) {
  const response = await fetch(`${CN_CHAT_BASE}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      Accept: "application/json",
      "User-Agent": CLIENT_UA,
      ...(cred.domain ? { "X-Domain": cred.domain } : {}),
      ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const doc = await response.json().catch(() => null);
  if (!response.ok || !doc || doc.code !== 0) {
    throw new Error(`token refresh failed (http ${response.status}): ${JSON.stringify(doc)?.slice(0, 200)}`);
  }
  const data = doc.data ?? {};
  if (typeof data.accessToken !== "string" || data.accessToken === "") throw new Error("refresh returned no accessToken");
  return {
    ...cred,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresAtMs: Number.isFinite(data.expiresIn) && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1e3 : cred.expiresAtMs,
  };
}

/** 把刷新结果存到本地副本，供 App 退出后继续使用。 */
export async function saveOwnCredential(cred, home = homedir()) {
  const own = ownCredentialPath(home);
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, JSON.stringify({ version: 1, savedAt: Date.now(), credential: cred }, null, 2), "utf8");
  return own;
}

/** 读本地副本；不存在或损坏都返回 null。 */
export async function readOwnCredential(home = homedir()) {
  try {
    const doc = JSON.parse(await readFile(ownCredentialPath(home), "utf8"));
    const cred = doc?.credential;
    if (!cred || typeof cred.accessToken !== "string" || cred.accessToken === "") return null;
    return {
      accessToken: cred.accessToken,
      refreshToken: typeof cred.refreshToken === "string" ? cred.refreshToken : "",
      expiresAtMs: expiryToMs(cred.expiresAtMs),
      domain: typeof cred.domain === "string" ? cred.domain : "",
      uid: typeof cred.uid === "string" ? cred.uid : "",
      enterpriseId: typeof cred.enterpriseId === "string" ? cred.enterpriseId : "",
    };
  } catch {
    return null;
  }
}

/** 桌面 auth 文件的 mtime 与路径；读不到返回 null。 */
export async function inspectDesktopAuthFile(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : desktopAuthCandidates();
  for (const file of candidates) {
    try {
      const st = await stat(file);
      return { path: file, mtimeMs: st.mtimeMs, size: st.size };
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- unified resolver

let cache = { cred: null, key: "", watched: "", mtimeMs: -1, source: "" };
let inflightRefresh = null;

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readDesktopCredential(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : desktopAuthCandidates();
  let lastErr;
  for (const file of candidates) {
    if (!(await fileExists(file))) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return { cred: await parseAuthDocAuto(await readFile(file, "utf8")), file };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
  }
  throw lastErr ?? new Error(`no WorkBuddy credential file (${candidates.join(", ")})`);
}

async function loadCredential(explicitPath, allowOwn) {
  let desktopErr;
  try {
    const read = await readDesktopCredential(explicitPath);
    // 读到桌面端凭据就顺手留一份本地副本：App 之后被关闭/卸载也能继续用。
    try {
      await saveOwnCredential(read.cred);
    } catch {}
    return { cred: read.cred, source: "desktop", file: read.file };
  } catch (err) {
    desktopErr = err;
  }
  if (allowOwn) {
    const own = await readOwnCredential();
    if (own) return { cred: own, source: "own" };
  }
  throw desktopErr;
}

async function refreshIfNeeded(cred) {
  if (!needsRefresh(cred)) return cred;
  inflightRefresh ??= (async () => {
    const next = await refreshCredential(cred);
    try {
      await saveOwnCredential(next);
    } catch {}
    return next;
  })().finally(() => {
    inflightRefresh = null;
  });
  try {
    return await inflightRefresh;
  } catch (err) {
    if (!isExpired(cred)) return cred;
    throw err;
  }
}

/**
 * Resolve a usable credential: desktop auth file -> local copy -> refresh when near expiry.
 * Options: { explicitPath, allowOwn = true, refresh = true }.
 */
export async function resolveCredential({ explicitPath, allowOwn = true, refresh = true } = {}) {
  const primary = explicitPath ?? desktopAuthCandidates()[0];
  const key = `${explicitPath ?? ""}|${allowOwn ? 1 : 0}`;
  let mtimeMs = -1;
  try {
    mtimeMs = (await stat(primary)).mtimeMs;
  } catch {}
  // cache.watched 记录真正读到的文件：桌面端可能只存在第二/第三候选。
  let fresh = false;
  if (cache.cred && cache.watched) {
    try {
      fresh = (await stat(cache.watched)).mtimeMs === cache.mtimeMs;
    } catch {
      fresh = false;
    }
  }
  if (fresh && cache.key === key) {
    const next = refresh ? await refreshIfNeeded(cache.cred) : cache.cred;
    cache.cred = next;
    return next;
  }
  let loaded;
  try {
    loaded = await loadCredential(explicitPath, allowOwn);
  } catch (err) {
    // 桌面端暂时读不到时，只要手上还有未过期的旧凭据就继续用。
    if (cache.cred && !isExpired(cache.cred)) return cache.cred;
    throw err;
  }
  const next = refresh ? await refreshIfNeeded(loaded.cred) : loaded.cred;
  const watchedAt = loaded.source === "desktop" && loaded.file
    ? loaded.file
    : loaded.source === "own" ? ownCredentialPath() : primary;
  let watchedMtime = mtimeMs;
  try {
    watchedMtime = (await stat(watchedAt)).mtimeMs;
  } catch {}
  cache = { cred: next, key, watched: watchedAt, mtimeMs: watchedMtime, source: loaded.source };
  return next;
}

/** Source of the last resolved credential: "desktop" or "own". */
export function credentialSource() {
  return cache.source;
}

/** Drop the in-memory cache so the next call re-reads the desktop auth file. */
export function invalidateCredential() {
  cache = { cred: null, key: "", watched: "", mtimeMs: -1, source: "" };
  inflightRefresh = null;
}
