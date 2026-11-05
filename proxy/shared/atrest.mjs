#!/usr/bin/env node
/**
 * WorkBuddy 桌面端「at-rest」加密凭据解密（移植自 dsh-connect-workbuddy 的 at-rest 模块）。
 *
 * 新版桌面端（5.6.0 起）把 auth.accessToken / refreshToken 写成：
 *   { "$wbEncrypted": 1, "envelope": "<base64 of JSON envelope>" }
 * envelope = { suite, keyId, nonce, authTag, ciphertext }，AES-256-GCM。
 *
 * 字段密钥不是用户密钥，而是编译进 App 原生模块的构建期常量：
 * 以 ELECTRON_RUN_AS_NODE 方式运行 App 本体，调
 * process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()
 * 取回 JSON payload，对其中的 atRestSecretKey（base64 字符串本身，不解码）
 * 做 SHA-256 得到 32 字节密钥；envelope.keyId 即该密钥 SHA-256 的前 16 个 hex。
 *
 * 密钥只缓存在进程内存，绝不落盘、绝不进日志。
 */
import { createDecipheriv, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const STANDARD_FORMAT_ID = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const SYMMETRIC_SCHEME = "sym-v1";
const KEY_FETCH_TIMEOUT_MS = 10_000;
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
const WINDOWS_APP_SUBDIRECTORIES = [
	["Programs", "WorkBuddy"],
	["WorkBuddy"],
	["Programs", "WorkBuddyAI"],
	["WorkBuddyAI"],
];

function encodeUint32(value) {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}
function encodeLengthPrefixed(value) {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error(`wb-atrest: envelope keyId is malformed`);
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID["field"]),
		encodeLengthPrefixed(scheme),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE["field"]]),
		Buffer.from([0]),
		Buffer.from([0]),
	]);
}
function isEncryptedFieldWrapper(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value).sort();
	return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope"
		&& value["$wbEncrypted"] === 1 && typeof value["envelope"] === "string";
}
function deriveAtRestKeyId(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
function deriveAtRestKey(payloadJson) {
	let payload;
	try { payload = JSON.parse(payloadJson); } catch { throw new Error("wb-atrest: key payload is not valid JSON"); }
	const secret = payload?.["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") throw new Error("wb-atrest: key payload carries no atRestSecretKey");
	return createHash("sha256").update(secret, "utf8").digest();
}
function openEncryptedField(field, key) {
	let envelope;
	try { envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8")); }
	catch { throw new Error("wb-atrest: envelope is not valid JSON"); }
	const { suite, keyId, nonce, authTag, ciphertext } = envelope ?? {};
	if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("wb-atrest: envelope missing suite or keyId");
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") throw new Error("wb-atrest: envelope missing nonce, authTag or ciphertext");
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) throw new Error(`wb-atrest: envelope belongs to key ${keyId}, not the available key ${expectedKeyId}`);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

// ---- 桌面 App 可执行文件定位 ----
import { spawnSync } from "node:child_process";
function appPathFromProcess() {
	if (platform() !== "win32") return undefined;
	const r = spawnSync("powershell", [
		"-NoProfile", "-Command",
		"(Get-Process -Name WorkBuddy,WorkBuddyAI -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique)",
	], { encoding: "utf8", timeout: 8000, windowsHide: true });
	const lines = (r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return lines.find((p) => isAppExecutable(p) && existsSync(p));
}
function appPathFromRegistry() {
	if (platform() !== "win32") return undefined;
	const hives = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"];
	for (const hive of hives) {
		const r = spawnSync("reg", ["query", hive, "/s", "/f", "WorkBuddy.exe", "/t", "REG_SZ"], { encoding: "utf8", timeout: 15000, windowsHide: true });
		const hits = (r.stdout || "").match(/[A-Z]:\\[^\r\n"]*?\\WorkBuddy(?:AI)?\.exe/gi) ?? [];
		const hit = hits.find((p) => isAppExecutable(p) && existsSync(p));
		if (hit) return hit;
	}
	return undefined;
}

/** 排除 "Uninstall WorkBuddy.exe" / "RepairApp.exe" 这类同目录辅助程序。 */
function isAppExecutable(file) {
	return /[\\/](WorkBuddy|WorkBuddyAI)\.exe$/i.test(file);
}
export function findWorkbuddyAppExecutable() {
	const envPath = process.env.WORKBUDDY_APP_EXECUTABLE;
	if (envPath && existsSync(envPath)) return envPath;
	const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	const bases = [local, process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean);
	for (const base of bases) for (const sub of WINDOWS_APP_SUBDIRECTORIES) for (const name of APP_EXECUTABLE_NAMES) {
		const candidate = join(base, ...sub, name);
		try { if (existsSync(candidate)) return candidate; } catch {}
	}
	return appPathFromProcess() || appPathFromRegistry() || undefined;
}

// ---- 密钥获取（进程级缓存；失败 60s 内不重复尝试）----
let cachedKey = null;
let inflightKey = null;
let failedKeyAtMs = 0;
const FAILURE_TTL_MS = 60_000;

async function fetchKeyPayload(executable) {
	const script = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
	const { stdout, stderr } = await execFileAsync(executable, ["-e", script], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		timeout: KEY_FETCH_TIMEOUT_MS,
		windowsHide: true,
		maxBuffer: 1024 * 1024,
	});
	const payload = (stdout || "").trim();
	if (payload === "") throw new Error(`wb-atrest: app returned empty key payload${stderr ? ` (${String(stderr).trim()})` : ""}`);
	return payload;
}
async function getAtRestKey() {
	if (cachedKey) return cachedKey;
	if (Date.now() - failedKeyAtMs < FAILURE_TTL_MS) throw new Error("wb-atrest: key unavailable (recent attempt failed; retry in a minute)");
	inflightKey ??= (async () => {
		const executable = findWorkbuddyAppExecutable();
		if (!executable) throw new Error("wb-atrest: WorkBuddy desktop app executable not found (is it installed/running?)");
		return deriveAtRestKey(await fetchKeyPayload(executable));
	})();
	try {
		cachedKey = await inflightKey;
		failedKeyAtMs = 0;
		return cachedKey;
	} catch (err) {
		failedKeyAtMs = Date.now();
		throw err;
	} finally {
		inflightKey = null;
	}
}

/** 若值是加密信封则解密返回明文字符串，否则原样返回。 */
export async function openFieldIfNeeded(value) {
	if (!isEncryptedFieldWrapper(value)) return value;
	return openEncryptedField(value, await getAtRestKey());
}

/**
 * 读入桌面 App 的 auth 文档（已 JSON.parse），解密其中的加密字段。
 * 返回 { accessToken, refreshToken, expiresAtMs, domain, uid }。
 */
export async function parseAuthDocWithDecrypt(doc) {
	const auth = doc?.auth && typeof doc.auth === "object" ? doc.auth : (doc ?? {});
	const identity = doc?.account && typeof doc.account === "object" ? doc.account : (doc ?? {});
	const accessToken = await openFieldIfNeeded(auth.accessToken);
	const refreshToken = await openFieldIfNeeded(auth.refreshToken);
	if (typeof accessToken !== "string" || accessToken === "") throw new Error("auth doc has no usable accessToken");
	const expiryToMs = (v) => (!Number.isFinite(v) || v <= 0 ? 0 : v > 1e12 ? v : v * 1e3);
	return {
		accessToken,
		refreshToken: typeof refreshToken === "string" ? refreshToken : "",
		expiresAtMs: expiryToMs(auth.expiresAt),
		domain: typeof auth.domain === "string" ? auth.domain : "",
		uid: typeof identity.uid === "string" ? identity.uid : "",
		enterpriseId: typeof identity.enterpriseId === "string" ? identity.enterpriseId : "",
	};
}
