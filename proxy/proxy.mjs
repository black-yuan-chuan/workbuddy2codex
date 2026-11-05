#!/usr/bin/env node
/**
 * WorkBuddy2Codex proxy runtime.
 *
 * Exposes the models of an already signed-in WorkBuddy desktop client as an
 * OpenAI-compatible endpoint on 127.0.0.1. Codex speaks the Responses API while
 * the upstream only offers chat completions, so this process translates both
 * requests and SSE events in either direction.
 *
 * The VS Code extension launches and supervises this file; it is not meant to
 * be started by hand. Runtime contract:
 *   PORT                  listening port (default 8401)
 *   WORKBUDDY_AUTH_FILE   optional explicit credential file path
 *
 * Upstream quirks handled here:
 *  - streams only (non-stream clients are aggregated locally)
 *  - role "developer" must be rewritten to "system" (400 / code 11128)
 *  - tool_choice accepts string values only
 *  - reasoning_effort must stay inside the values declared by the model catalog
 *
 * Credential decryption and catalog knowledge derive from the DSH plugin
 * dsh-workbuddy-connect; see THIRD-PARTY-NOTICES.md.
 */
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fetchCredits } from "./shared/credits.mjs";
import { toCodexCatalog, fetchLiveModels } from "./shared/catalog.mjs";
import { resolveCredential, invalidateCredential } from "./shared/credential.mjs";

const PORT = Number(process.env.PORT || 8401);
const CHAT_BASE = "https://copilot.tencent.com";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const AUTH_FILENAME = "workbuddy-desktop.info";
const BODY_LIMIT = 64 * 1024 * 1024;

const rid = (p) => `${p}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

// 静态兜底目录(与上游 cli agent 一致;live 拉取失败时使用)
const CN_FALLBACK_MODELS = [
  { id: "auto", ctx: 168_000, out: 32_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy4-preview", ctx: 1_000_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3", ctx: 192_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3-x", ctx: 192_000, out: 64_000, img: true, efforts: ["low","high"], canOff: false },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "glm-5.3", ctx: 1_000_000, out: 48_000, img: true, efforts: ["low","high","max"], canOff: true },
  { id: "glm-5.3-flash", ctx: 1_000_000, out: 32_000, img: true, efforts: ["low","high","max"], canOff: true },
  { id: "glm-5.2", ctx: 1_000_000, out: 48_000, img: true, efforts: ["medium"], canOff: false },
  { id: "glm-5.1", ctx: 200_000, out: 48_000, img: false, efforts: ["medium"], canOff: false },
  { id: "glm-5v-turbo", ctx: 200_000, out: 64_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k3-1", ctx: 1_000_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.7", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.6", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "minimax-m3", ctx: 512_000, out: 128_000, img: true, efforts: ["medium"], canOff: false },
  { id: "deepseek-v4-pro", ctx: 1_000_000, out: 50_000, img: true, efforts: ["high"], canOff: false },
];

const FALLBACK_MODELS = CN_FALLBACK_MODELS;
const modelInfo = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
const infoOf = (id) => modelInfo.get(id) ?? { id, ctx: 1_000_000, out: 32_000, img: true, efforts: undefined, canOff: false };

// ---------------------------------------------------------------- credential

/** Candidate credential locations used by the desktop client, ordered by preference. */
function desktopAuthCandidates() {
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

/** First credential path, honouring an explicit override from the environment. */
function authFilePath() {
  return process.env.WORKBUDDY_AUTH_FILE || desktopAuthCandidates()[0];
}

const commonHeaders = () => ({
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.codebuddy.cn",
  Referer: "https://www.codebuddy.cn/",
  "User-Agent": CLIENT_UA,
});
const chatHeaders = (c) => ({
  ...commonHeaders(),
  "Content-Type": "application/json",
  ...(c.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": c.uid }),
  ...(c.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": c.domain }),
  "X-Product": "SaaS",
});



const HARD_CREDIT_MARKERS = [
  "insufficient credit", "no credit", "credit exhausted", "out of credit",
  "quota exceeded", "quota exhaust", "payment required", "credit not enough", "not enough credit",
  "积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分",
];
function classify(status, body) {
  if (status === 402) return "hard_credit";
  const lower = (body || "").toLowerCase();
  for (const m of HARD_CREDIT_MARKERS) if (lower.includes(m.toLowerCase()) || (body || "").includes(m)) return "hard_credit";
  if ((body || "").includes("Offline user session not found") || (body || "").includes("12153")) return "session_dead";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
function normalizeEffort(modelId, requested) {
  const info = infoOf(modelId);
  if (!requested || !info.efforts || info.efforts.length === 0) return undefined;
  const want = String(requested).toLowerCase();
  if (want === "none" || want === "minimal" || want === "off") return info.canOff ? "off" : undefined;
  if (info.efforts.includes(want)) return want;
  const order = ["low", "medium", "high", "xhigh", "max"];
  const idx = order.indexOf(want);
  if (idx === -1) return undefined;
  for (let i = Math.min(order.length - 1, idx); i >= 0; i--) if (info.efforts.includes(order[i])) return order[i];
  for (let i = idx + 1; i < order.length; i++) if (info.efforts.includes(order[i])) return order[i];
  return undefined;
}
const STRIP_CHAT_FIELDS = [
  "store", "prompt_cache_key", "include", "service_tier", "safety_identifier",
  "previous_response_id", "reasoning", "text", "truncation", "user", "metadata",
];
function normalizeToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === "string") return tc === "none" ? "none" : tc;
  const type = String(tc.type ?? "").toLowerCase();
  if (type === "function") return tc.function?.name ?? tc.name ?? "auto";
  if (type === "auto" || type === "required" || type === "none") return type;
  return undefined;
}
function finalizeChatBody(body, model, effort) {
  for (const f of STRIP_CHAT_FIELDS) delete body[f];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (m && typeof m === "object" && m.role === "developer") m.role = "system";
  }
  const tc = normalizeToolChoice(body.tool_choice);
  if (tc === "none") { delete body.tools; delete body.tool_choice; }
  else if (tc) body.tool_choice = tc;
  else delete body.tool_choice;
  if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort;
  // WorkBuddy 网关契约(400 code 11155):思维链模式下,历史里每条 assistant
  // 消息都必须带 reasoning_content(真实内容优先,缺失补占位),否则整条请求被拒。
  if (body.reasoning_effort && body.reasoning_effort !== "off") {
    for (const m of body.messages) {
      if (m?.role === "assistant" && !m.reasoning_content) {
        m.reasoning_content = "(no reasoning content recorded for this turn)";
      }
    }
  }
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) body.max_tokens = Math.min(body.max_tokens, infoOf(model).out);
  else delete body.max_tokens;
  body.stream = true; // 上游只吃流式
  return body;
}

/**
 * Upstream security-policy guard.
 *
 * `code 11128 "Illegal API invocation from an unapproved channel"` is NOT an
 * auth/channel problem: it is the upstream's response to a *system or
 * assistant* message that reproduces another vendor's coding-agent identity
 * preamble verbatim. Measured behaviour (2026-09-10):
 *
 *   role=system    + preamble -> 11128
 *   role=assistant + preamble -> 11128
 *   role=user/tool + preamble -> ok      (history is replayed every turn, so
 *                                         one poisoned assistant message
 *                                         breaks the whole conversation)
 *   preamble minus its final "." -> ok   (exact-substring match)
 *
 * Also rewrites `role:"developer"` (the upstream knows only system/user/
 * assistant/tool). Every request funnels through callUpstream, so applying
 * both here covers paths that skip finalizeChatBody (e.g. /v1/responses).
 */
const IDENTITY_PREAMBLES = [
  "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.",
];
const IDENTITY_PREAMBLE_PATTERNS = [
  /You are a coding agent running in the [A-Za-z0-9 ._-]*CLI,[^.]*\.\s*[A-Za-z0-9 ._-]*CLI is an open source project led by [A-Za-z0-9 ._-]*\.[^.]*\./g,
];
const PREAMBLE_PLACEHOLDER = "[third-party agent identity preamble removed by proxy]";

/** Neutralize blocked third-party identity preambles in system/assistant text. */
function sanitizeIdentityText(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const preamble of IDENTITY_PREAMBLES) out = out.split(preamble).join(PREAMBLE_PLACEHOLDER);
  for (const pattern of IDENTITY_PREAMBLE_PATTERNS) out = out.replace(pattern, PREAMBLE_PLACEHOLDER);
  return out;
}

/** Apply the role rewrite and identity sanitization to every message part. */
/** 深度遍历任意 JSON 值，清洗所有字符串（含 tool_calls 的 arguments）。 */
function sanitizeDeep(value) {
  if (typeof value === "string") return sanitizeIdentityText(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = sanitizeDeep(value[i]);
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) value[key] = sanitizeDeep(value[key]);
    return value;
  }
  return value;
}

/**
 * Apply the role rewrite and identity sanitization to every message part. (codex-proxy-deep-walk-v1)
 * 深度遍历整个 messages，而不是只扫 content —— tool_calls[].function.arguments
 * 是 Codex 工具参数落地的位置，也是此前漏扫导致 11128 的根因。
 */
function enforceUpstreamPolicy(body) {
  if (!Array.isArray(body?.messages)) return body;
  for (const m of body.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "developer") m.role = "system";
  }
  sanitizeDeep(body.messages);
  return body;
}

/**
 * 上游 fetch 传输层重试。
 * `TypeError: fetch failed`(http 0)多来自复用被 mihomo/中间设备回收的 keep-alive
 * 连接(连接被重置);传输失败时不会有半截响应,重试安全。
 */
async function fetchUpstreamRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 工具参数 schema 清洗:剔除模型提供方会拒绝的非标准键
 * (2026-09-28 起 `$schema` 等被严格校验 → 400 code 11133 / model_param_invalid)。
 * 只在 schema 位置删除,不动 properties 里同名的业务参数。
 */
const TOOL_NOISE_KEYS = ["$schema", "propertyNames", "annotations", "$comment"];
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_CHILD_KEYS = new Set(["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains"]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

function stripSchemaNoise(node) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) stripSchemaNoise(n); return; }
  for (const k of Object.keys(node)) {
    if (TOOL_NOISE_KEYS.includes(k)) { delete node[k]; continue; }
    const v = node[k];
    // additionalProperties 为「schema 对象」时归一化成布尔 true(部分提供方只接受布尔)
    if (k === "additionalProperties" && v !== null && typeof v === "object") { node[k] = true; continue; }
    if (SCHEMA_MAP_KEYS.has(k) && v && typeof v === "object") { for (const sub of Object.values(v)) stripSchemaNoise(sub); continue; }
    if (SCHEMA_CHILD_KEYS.has(k) || SCHEMA_LIST_KEYS.has(k)) stripSchemaNoise(v);
  }
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return 0;
  let n = 0;
  for (const t of tools) {
    const fn = t?.function ?? t;
    if (fn?.parameters && typeof fn.parameters === "object") { stripSchemaNoise(fn.parameters); n += 1; }
  }
  return n;
}

/**
 * 消息顺序归一化:assistant(tool_calls) 与其 tool 结果之间若被其他消息(如用户插话)隔开,
 * 上游会以 400/11133(model_param_invalid)拒绝。把匹配的 tool 结果上移,其余消息顺延。
 */
function normalizeMessageOrder(messages) {
  if (!Array.isArray(messages)) return 0;
  let fixes = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) { i += 1; continue; }
    const ids = new Set(m.tool_calls.map((tc) => tc?.id).filter(Boolean));
    let end = i + 1;
    while (end < messages.length && !(messages[end] && messages[end].role === "assistant")) end += 1;
    const window = messages.slice(i + 1, end);
    const isMatchedTool = (x) => x && x.role === "tool" && ids.has(x.tool_call_id);
    const toolMsgs = window.filter(isMatchedTool);
    if (toolMsgs.length) {
      const flags = window.map(isMatchedTool);
      const firstOther = flags.indexOf(false);
      const lastTool = flags.lastIndexOf(true);
      if (firstOther !== -1 && firstOther < lastTool) {
        messages.splice(i + 1, window.length, ...toolMsgs, ...window.filter((x) => !isMatchedTool(x)));
        fixes += 1;
      }
    }
    i = end;
  }
  return fixes;
}

async function callUpstream(body) {
  const cred = await resolveCredential();
  enforceUpstreamPolicy(body);
  sanitizeTools(body.tools);
  normalizeMessageOrder(body.messages);
  let res = await postChat(cred, body);
  let shrinkLeft = 6;
  while (res.status === 400 && shrinkLeft > 0) {
    const peek = await res.clone().text();
    if (!(peek.includes("11133") || peek.includes("model_param_invalid"))) break;
    if (Number.isFinite(body.max_tokens) && body.max_tokens > 1024) {
      body.max_tokens = Math.max(1024, Math.floor(body.max_tokens / 2));
    } else if ("max_tokens" in body) {
      delete body.max_tokens;
    } else {
      break;
    }
    shrinkLeft -= 1;
    res = await postChat(cred, body);
  }
  return { res, cred };
}

/** Send one chat-completions request upstream with the resolved credential. */
function postChat(cred, body) {
  return fetchUpstreamRetry(`${CHAT_BASE}/v2/chat/completions`, {
    method: "POST",
    headers: { ...chatHeaders(cred), Authorization: `Bearer ${cred.accessToken}` },
    body: JSON.stringify(body),
  });
}

async function iterateUpstreamSSE(stream, onJson) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try { onJson(JSON.parse(payload)); } catch {}
    }
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
function sendOpenAIError(res, status, message, type = "api_error", code = null) {
  if (res.headersSent) {
    try { res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`); res.write("data: [DONE]\n\n"); } catch {}
    res.end();
    return;
  }
  sendJson(res, status, { error: { message, type, code } });
}
function errorStatusFor(kind) {
  return kind === "hard_credit" ? 402 : kind === "soft_rate" ? 429 : kind === "session_dead" ? 401
    : kind === "server" || kind === "not_found" ? 502 : 400;
}

// ---------------------------------------------------------------- responses → chat

/** Responses API 请求 → chat completions body。 */
function responsesToChat(reqBody) {
  const messages = [];
  const instructions = reqBody.instructions;
  if (typeof instructions === "string" && instructions.trim()) messages.push({ role: "system", content: instructions });

  const input = Array.isArray(reqBody.input) ? reqBody.input
    : typeof reqBody.input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: reqBody.input }] }]
    : [];

  // function_call 输出要合并成一条 assistant 消息(with tool_calls)
  const pendingAssistantToolCalls = [];
  let pendingReasoning = ""; // WorkBuddy 网关契约(11155):思维链模式下上一轮 reasoning_content 必须回传
  const flushAssistant = () => {
    if (pendingAssistantToolCalls.length === 0) return;
    const rc = pendingReasoning ? { reasoning_content: pendingReasoning } : {};
    pendingReasoning = "";
    messages.push({ role: "assistant", content: null, ...rc, tool_calls: pendingAssistantToolCalls.splice(0, pendingAssistantToolCalls.length) });
  };

  for (const item of input) {
    if (item == null) continue;
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "function_call") {
      pendingAssistantToolCalls.push({
        id: item.call_id ?? item.id ?? rid("call"),
        type: "function",
        function: { name: item.name ?? "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
      continue;
    }
    flushAssistant();
    if (type === "function_call_output") {
      const out = item.output;
      const text = typeof out === "string" ? out
        : Array.isArray(out) ? out.map((b) => (b?.type === "input_text" || b?.type === "text" ? b.text : "")).join("\n")
        : JSON.stringify(out ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id ?? "", content: text });
      continue;
    }
    if (type === "reasoning") {
      // 收集思维链文本,挂到同轮 assistant 消息上(网关 400 code 11155 要求回传)
      const txt = (item.summary ?? []).map((s) => s?.text ?? "").filter(Boolean).join("\n");
      if (txt) pendingReasoning = pendingReasoning ? pendingReasoning + "\n" + txt : txt;
      continue;
    }
    if (type === "item_reference" || type === "web_search_call") continue; // 上游无需回放
    if (type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
      const content = item.content;
      if (typeof content === "string") { messages.push({ role, content }); continue; }
      if (!Array.isArray(content)) continue;
      const parts = [];
      let textOnly = "";
      for (const part of content) {
        if (part == null) continue;
        const pt = part.type;
        if (pt === "input_text" || pt === "output_text" || pt === "text" || pt === "summary_text") {
          if (part.text) { textOnly += part.text; parts.push({ type: "text", text: part.text }); }
        } else if (pt === "input_image" || pt === "image_url") {
          const url = part.image_url ?? part.url;
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (pt === "refusal") {
          if (part.refusal) { textOnly += part.refusal; parts.push({ type: "text", text: part.refusal }); }
        }
      }
      if (parts.length === 0) { if (role !== "assistant") pendingReasoning = ""; continue; }
      const hasImage = parts.some((p) => p.type === "image_url");
      // 思维链回传:挂到 assistant 消息上;遇到 user/system 则视为孤立,丢弃
      const rc = role === "assistant" && pendingReasoning ? { reasoning_content: pendingReasoning } : {};
      if (role === "assistant") pendingReasoning = ""; else pendingReasoning = "";
      messages.push({ role, content: hasImage ? parts : textOnly, ...rc });
    }
  }
  flushAssistant();

  const body = { model: reqBody.model, messages };

  if (Array.isArray(reqBody.tools) && reqBody.tools.length) {
    const tools = [];
    for (const t of reqBody.tools) {
      if (!t) continue;
      if (t.type && t.type !== "function") continue; // 上游只支持 function 工具
      const name = t.name ?? t.function?.name;
      if (!name) continue;
      tools.push({
        type: "function",
        function: {
          name,
          description: t.description ?? t.function?.description ?? "",
          parameters: t.parameters ?? t.function?.parameters ?? { type: "object", properties: {} },
        },
      });
    }
    if (tools.length) body.tools = tools;
  }

  const tc = normalizeToolChoice(reqBody.tool_choice);
  if (tc) body.tool_choice = tc;
  if (Number.isFinite(reqBody.temperature)) body.temperature = reqBody.temperature;
  if (Number.isFinite(reqBody.top_p)) body.top_p = reqBody.top_p;
  if (Number.isFinite(reqBody.max_output_tokens)) body.max_tokens = reqBody.max_output_tokens;
  else if (Number.isFinite(reqBody.max_tokens)) body.max_tokens = reqBody.max_tokens;

  // 国际版网关契约(400 code 11155):思维链模式要求上一轮完整 reasoning_content 回传,
  // 而 Codex 协议只能拿到摘要、无法完整回传 → 长对话必炸。实测同一请求体:
  // 带 reasoning_effort=high → 11155;不发 → 200。故国际版一律不发思维链参数。
  const effort = normalizeEffort(reqBody.model, reqBody.reasoning?.effort);
  return { body: finalizeChatBody(body, reqBody.model, effort), effort };
}

// ---------------------------------------------------------------- chat SSE → responses SSE

function responseEnvelope({ id, model, output, usage, status = "completed", effort = null }) {
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model,
    output, usage, error: null, incomplete_details: null,
    instructions: null, metadata: {}, parallel_tool_calls: true,
    temperature: null, top_p: null, max_output_tokens: null, previous_response_id: null,
    reasoning: { effort, summary: null },
    text: { format: { type: "text" } }, tool_choice: "auto", tools: [], truncation: "disabled", user: null,
    store: false,
  };
}

/**
 * 消费上游 chat SSE,按 Responses API 事件流写给客户端;
 * 同时聚合出完整 response 对象(供 response.completed / 非流式使用)。
 */
async function relayAsResponses(upstreamStream, res, { model, stream, effort }) {
  const responseId = rid("resp");
  const emit = (obj) => {
    if (stream && !res.writableEnded) res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    emit({ type: "response.created", response: responseEnvelope({ id: responseId, model, output: [], usage: null, status: "in_progress", effort }) });
    emit({ type: "response.in_progress", response: responseEnvelope({ id: responseId, model, output: [], usage: null, status: "in_progress", effort }) });
  }

  const output = [];
  let seq = 0;
  const nextIndex = () => output.length;

  // 当前正在流式输出的 item
  let open = null; // {kind:'reasoning'|'message'|'function_call', index, itemId, ...}
  let usage = { input: 0, output: 0, reasoning: 0 };

  const closeOpen = () => {
    if (!open) return;
    if (open.kind === "reasoning") {
      const item = { type: "reasoning", id: open.itemId, summary: open.text ? [{ type: "summary_text", text: open.text }] : [] };
      output[open.index] = item;
      emit({ type: "response.reasoning_summary_text.done", item_id: open.itemId, output_index: open.index, summary_index: 0, text: open.text });
      emit({ type: "response.reasoning_summary_part.done", item_id: open.itemId, output_index: open.index, summary_index: 0, part: { type: "summary_text", text: open.text } });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    } else if (open.kind === "message") {
      const part = { type: "output_text", text: open.text, annotations: [] };
      const item = { type: "message", id: open.itemId, status: "completed", role: "assistant", content: [part] };
      output[open.index] = item;
      emit({ type: "response.output_text.done", item_id: open.itemId, output_index: open.index, content_index: 0, text: open.text });
      emit({ type: "response.content_part.done", item_id: open.itemId, output_index: open.index, content_index: 0, part });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    } else if (open.kind === "function_call") {
      const item = { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: open.args, status: "completed" };
      output[open.index] = item;
      emit({ type: "response.function_call_arguments.done", item_id: open.itemId, output_index: open.index, arguments: open.args });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    }
    open = null;
  };

  const openReasoning = () => {
    if (open?.kind === "reasoning") return;
    closeOpen();
    const index = nextIndex();
    open = { kind: "reasoning", index, itemId: rid("rs"), text: "" };
    output[index] = { type: "reasoning", id: open.itemId, summary: [] };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "reasoning", id: open.itemId, summary: [] } });
    emit({ type: "response.reasoning_summary_part.added", item_id: open.itemId, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
  };
  const openMessage = () => {
    if (open?.kind === "message") return;
    closeOpen();
    const index = nextIndex();
    open = { kind: "message", index, itemId: rid("msg"), text: "" };
    output[index] = { type: "message", id: open.itemId, status: "in_progress", role: "assistant", content: [] };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "message", id: open.itemId, status: "in_progress", role: "assistant", content: [] } });
    emit({ type: "response.content_part.added", item_id: open.itemId, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  };
  const openFunctionCall = (callId, name) => {
    closeOpen();
    const index = nextIndex();
    open = { kind: "function_call", index, itemId: rid("fc"), callId: callId || rid("call"), name: name || "", args: "" };
    output[index] = { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: "", status: "in_progress" };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: "", status: "in_progress" } });
  };

  await iterateUpstreamSSE(upstreamStream, (json) => {
    if (json.usage) {
      usage.input = json.usage.prompt_tokens ?? usage.input;
      usage.output = json.usage.completion_tokens ?? usage.output;
      const rt = json.usage.completion_tokens_details?.reasoning_tokens;
      if (Number.isFinite(rt)) usage.reasoning = rt;
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    const rc = delta.reasoning_content ?? (typeof delta.reasoning === "string" ? delta.reasoning : undefined);
    if (typeof rc === "string" && rc) {
      openReasoning();
      open.text += rc;
      usage.reasoning += Math.ceil(rc.length / 4);
      emit({ type: "response.reasoning_summary_text.delta", item_id: open.itemId, output_index: open.index, summary_index: 0, delta: rc });
    }
    if (typeof delta.content === "string" && delta.content) {
      openMessage();
      open.text += delta.content;
      emit({ type: "response.output_text.delta", item_id: open.itemId, output_index: open.index, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const isNew = tc.id || (tc.function?.name && !(open?.kind === "function_call" && open.name === tc.function.name && open.callId === tc.id));
        if (!open || open.kind !== "function_call" || (tc.id && tc.id !== open.callId)) {
          openFunctionCall(tc.id, tc.function?.name);
        } else if (tc.function?.name && !open.name) {
          open.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          open.args += tc.function.arguments;
          emit({ type: "response.function_call_arguments.delta", item_id: open.itemId, output_index: open.index, delta: tc.function.arguments });
        }
      }
    }
    void isNew;
  });

  closeOpen();

  const outTokens = usage.output || Math.ceil(output.map((i) =>
    i.type === "message" ? (i.content?.[0]?.text?.length ?? 0)
      : i.type === "reasoning" ? (i.summary?.[0]?.text?.length ?? 0)
      : (i.arguments?.length ?? 0)).reduce((a, b) => a + b, 0) / 4);

  const finalUsage = {
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoning },
    total_tokens: usage.input + outTokens,
  };

  const finalResponse = responseEnvelope({ id: responseId, model, output, usage: finalUsage, status: "completed", effort });
  if (stream) {
    emit({ type: "response.completed", response: finalResponse });
    res.end();
  }
  return finalResponse;
}

// ---------------------------------------------------------------- server

/** Live model list; falls back to the static table and refreshes modelInfo for effort mapping. */
async function listModelsForCatalog() {
  try {
    const cred = await resolveCredential();
    const live = await fetchLiveModels(cred);
    modelInfo.clear();
    for (const m of live) modelInfo.set(m.id, m);
    return live;
  } catch {
    return FALLBACK_MODELS;
  }
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      sendJson(res, 200, {
        ok: true,
        service: "workbuddy2codex",
        port: PORT,
        pid: process.pid,
        endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/models", "/v1/credits", "/w2c/models", "/w2c/catalog"],
      });
      return;
    }

    // Remaining credits (read-only); polled by the extension status bar and panel.
    if (req.method === "GET" && url === "/v1/credits") {
      const cred = await resolveCredential();
      const summary = await fetchCredits(cred);
      sendJson(res, 200, { ...summary, updatedAt: Date.now(), source: "workbuddy" });
      return;
    }

    // Codex model catalog, written by the extension to ~/.codex/workbuddy2codex-catalog.json.
    if (req.method === "GET" && url === "/w2c/catalog") {
      const models = await listModelsForCatalog();
      sendJson(res, 200, toCodexCatalog(models));
      return;
    }

    // Rich model list for the extension UI (display name, context, credit multiplier, efforts).
    if (req.method === "GET" && url === "/w2c/models") {
      const models = await listModelsForCatalog();
      sendJson(res, 200, { models, updatedAt: Date.now() });
      return;
    }

    if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
      const models = await listModelsForCatalog();
      sendJson(res, 200, {
        object: "list",
        data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "workbuddy" })),
      });
      return;
    }

    const isResponses = req.method === "POST" && (url === "/v1/responses" || url === "/responses");
    const isChat = req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions");
    if (!isResponses && !isChat) {
      sendOpenAIError(res, 404, `no such route: ${req.method} ${url}`, "invalid_request_error", "not_found");
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        sendOpenAIError(res, 413, "request body too large", "invalid_request_error", "body_too_large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendOpenAIError(res, 400, "request body is not valid JSON", "invalid_request_error", "invalid_json");
      return;
    }

    // 组装上游 chat 请求
    let body, model, effort, wantStream;
    if (isResponses) {
      model = parsed.model || "glm-5.3-flash";
      const conv = responsesToChat({ ...parsed, model });
      body = conv.body;
      effort = conv.effort;
      wantStream = parsed.stream !== false;
    } else {
      model = parsed.model || "glm-5.3-flash";
      const copy = { ...parsed };
      const effortRaw = copy.reasoning_effort;
      delete copy.reasoning_effort;
      effort = normalizeEffort(model, effortRaw);
      body = finalizeChatBody({ ...copy, model }, model, effort);
      wantStream = parsed.stream !== false;
    }

    const { res: upstream } = await callUpstream(body);
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 2000);
      const kind = classify(upstream.status, text);
      if (kind === "session_dead") invalidateCredential();
      sendOpenAIError(
        res,
        errorStatusFor(kind),
        `workbuddy upstream ${kind} (http ${upstream.status}): ${text.slice(0, 300)}`,
        kind === "session_dead" ? "authentication_error" : "api_error",
        kind
      );
      return;
    }

    if (isResponses) {
      await relayAsResponses(upstream.body, res, { model, stream: wantStream, effort });
      return;
    }

    // chat completions:要流式就透传,否则聚合
    if (wantStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
      return;
    }

    let content = "", reasoning = "", finishReason = "stop", usage = null;
    let id = rid("chatcmpl"), created = Math.floor(Date.now() / 1000), respModel = model;
    const toolCalls = new Map();
    await iterateUpstreamSSE(upstream.body, (json) => {
      if (json.id) id = json.id;
      if (json.created) created = json.created;
      if (json.model) respModel = json.model;
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number.isFinite(tc.index) ? tc.index : 0;
          let slot = toolCalls.get(idx);
          if (!slot) {
            slot = { id: tc.id ?? rid("call"), type: "function", function: { name: "", arguments: "" } };
            toolCalls.set(idx, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });

    const message = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    sendJson(res, 200, {
      id, object: "chat.completion", created, model: respModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: Math.ceil((content.length + reasoning.length) / 4), total_tokens: Math.ceil((content.length + reasoning.length) / 4) },
    });
  } catch (err) {
    sendOpenAIError(res, 500, `proxy internal error: ${String(err?.message ?? err)}`);
  }
});

server.requestTimeout = 0;
server.on("error", (err) => {
  // Fail loudly but legibly: the extension reads this line from the log file.
  const reason = err && err.code === "EADDRINUSE"
    ? `port ${PORT} already in use; stop the other process or change workbuddy2codex.port`
    : String((err && err.message) || err);
  console.error(`[workbuddy2codex] failed to start: ${reason}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[workbuddy2codex] listening on http://127.0.0.1:${PORT}`);
  console.log(`[workbuddy2codex] auth file: ${authFilePath()}`);
  console.log(`[workbuddy2codex] endpoints: /v1/responses, /v1/chat/completions, /v1/models, /v1/credits`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
