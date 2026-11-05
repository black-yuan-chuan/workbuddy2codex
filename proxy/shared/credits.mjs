/**
 * WorkBuddy 剩余积分查询（只读）。
 *
 * 上游：POST {billingBase}/v2/billing/meter/get-user-resource
 * - 企业账号走 /billing/meter/get-enterprise-user-usage（limitNum - credit）
 * - 个人账号按积分包逐条汇总：月度包看 CycleCapacityRemain，一次性包看
 *   CapacityRemain，过期或耗尽的一次性包不计入
 *
 * 该接口只读，不消耗积分。
 */
import { CN_BILLING_BASE, CLIENT_UA } from "./credential.mjs";

const JSON_TIMEOUT_MS = 30_000;
const SOON_MS = 72 * 3600 * 1000;

function billingHeaders(cred) {
  return {
    Authorization: `Bearer ${cred.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": `WorkBuddy/5.17.0`,
    ...(cred.uid ? { "X-User-Id": cred.uid } : {}),
    ...(cred.domain ? { "X-Domain": cred.domain } : {}),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId, "X-Tenant-Id": cred.enterpriseId } : {}),
  };
}

function parseDate(raw) {
  if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
  if (typeof raw === "string" && raw !== "") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function precise(account, key) {
  for (const k of [`${key}Precise`]) {
    const raw = account[k];
    if (typeof raw === "string" && raw !== "") {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n)) return n;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  const n = account[key];
  return typeof n === "number" ? n : 0;
}

/** 把上游 Accounts 数组折算成总计与分包。 */
export function summarizePackages(rawAccounts, now = Date.now()) {
  const packages = [];
  let total = 0;
  let expiringSoon = 0;
  let nearestExpiryMs;

  for (const account of rawAccounts) {
    if (typeof account !== "object" || account === null) continue;
    const monthly = account.CapacityType === 4;
    const size = precise(account, "CycleCapacitySize") || precise(account, "CapacitySize");
    const hasCycleRemain = account.CycleCapacityRemain !== undefined || account.CycleCapacityRemainPrecise !== undefined;
    const remainRaw = hasCycleRemain ? precise(account, "CycleCapacityRemain") : precise(account, "CapacityRemain");
    const remain = remainRaw < 0 ? 0 : remainRaw;
    const cycleEndMs = parseDate(account.CycleEndTime);
    const expiresAtMs = monthly ? undefined : parseDate(account.ExpiredTime) ?? cycleEndMs;
    if (!monthly && (remain <= 0 || (expiresAtMs !== undefined && expiresAtMs <= now))) continue;
    total += remain;
    if (expiresAtMs !== undefined) {
      if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs;
      if (expiresAtMs - now <= SOON_MS) expiringSoon += remain;
    }
    packages.push({
      name: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
      remain,
      size,
      monthly,
      expiresAtMs,
      refreshAtMs: monthly && cycleEndMs !== undefined ? cycleEndMs + 1e3 : undefined,
    });
  }
  return { total, packages, expiringSoon, nearestExpiryMs };
}

async function readEnvelope(response) {
  const json = await response.json().catch(() => null);
  return json ?? { code: -1, msg: `unreadable body (http ${response.status})` };
}

function envelopeError(status, envelope) {
  return new Error(`billing http ${status} code ${envelope?.code}: ${String(envelope?.msg ?? "").slice(0, 200)}`);
}

async function fetchEnterpriseCredits(cred) {
  const response = await fetch(`${CN_BILLING_BASE}/billing/meter/get-enterprise-user-usage`, {
    method: "POST",
    headers: billingHeaders(cred),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
  const inner = typeof wrapper.Data === "object" && wrapper.Data !== null ? wrapper.Data : wrapper;
  const limit = Number.isFinite(inner.limitNum) ? inner.limitNum : undefined;
  const used = Number.isFinite(inner.credit) ? inner.credit : undefined;
  if (limit === undefined || used === undefined) return undefined;
  const remain = Math.max(0, limit - used);
  return {
    total: remain,
    packages: [{ name: "企业积分", remain, size: limit, monthly: true }],
    expiringSoon: 0,
    enterprise: true,
  };
}

/** 查询剩余积分（只读）。cred 需含 accessToken/uid/domain(/enterpriseId)。 */
export async function fetchCredits(cred) {
  if (cred.enterpriseId) {
    const enterprise = await fetchEnterpriseCredits(cred);
    if (enterprise) return enterprise;
  }
  const now = new Date();
  const format = (date) => [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-") + " " + [
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
    date.getSeconds().toString().padStart(2, "0"),
  ].join(":");

  const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers: billingHeaders(cred),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: format(now),
      PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6)),
    }),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
  const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
  const data = typeof wrapper.Response === "object" && wrapper.Response !== null ? wrapper.Response : {};
  const inner = typeof data.Data === "object" && data.Data !== null ? data.Data : {};
  const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  return summarizePackages(accounts);
}

/** 积分显示用的短文本。 */
export function formatCredits(summary) {
  if (!summary) return "—";
  const total = Math.round(summary.total * 100) / 100;
  return `${total}`;
}
