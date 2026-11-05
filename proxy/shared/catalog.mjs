/**
 * WorkBuddy 模型目录（国内版）与 Codex model catalog 生成。
 *
 * 两个输出面：
 *   - `fetchLiveModels()` 返回代理自己用的精简表 { id, ctx, out, img, efforts, canOff }
 *   - `toCodexCatalog()` 生成 codex-cli 的 model_catalog_json（字段较严格，
 *     缺字段会直接让 Codex 启动失败，故按实测样本给全默认值）
 */
import { CN_CHAT_BASE, CLIENT_UA } from "./credential.mjs";

const JSON_TIMEOUT_MS = 30_000;

/** 上游拉不到时的兜底表（与 cli agent 通道一致）。 */
export const CN_FALLBACK_MODELS = [
  { id: "auto", ctx: 168_000, out: 32_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy4-preview", ctx: 1_000_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3", ctx: 192_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3-x", ctx: 192_000, out: 64_000, img: true, efforts: ["low", "high"], canOff: false },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "glm-5.3", ctx: 1_000_000, out: 48_000, img: true, efforts: ["low", "high", "max"], canOff: true },
  { id: "glm-5.3-flash", ctx: 1_000_000, out: 32_000, img: true, efforts: ["low", "high", "max"], canOff: true },
  { id: "glm-5.2", ctx: 1_000_000, out: 48_000, img: true, efforts: ["medium"], canOff: false },
  { id: "glm-5.1", ctx: 200_000, out: 48_000, img: false, efforts: ["medium"], canOff: false },
  { id: "glm-5v-turbo", ctx: 200_000, out: 64_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k3-1", ctx: 1_000_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.7", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.6", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "minimax-m3", ctx: 512_000, out: 128_000, img: true, efforts: ["medium"], canOff: false },
  { id: "deepseek-v4-pro", ctx: 1_000_000, out: 50_000, img: true, efforts: ["high"], canOff: false },
];

const EFFORT_LABELS = {
  low: "Fast, shallow reasoning",
  medium: "Balanced reasoning depth",
  high: "Deep reasoning for hard problems",
  xhigh: "Very deep reasoning",
  max: "Maximum reasoning depth for the hardest problems",
};

/**
 * 每条 catalog 条目必须给出系统提示词，否则 Codex 拒绝启动：
 * `model X is missing both base_instructions and model_messages.instructions_template`。
 * 这里只放最小身份声明，具体工作流由 Codex 自身注入。
 */
const BASE_INSTRUCTIONS = [
  "You are a coding agent running in the Codex CLI.",
  "You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
].join(" ");

/** 上游 `/console/enterprises/personal/models` → 精简模型表。 */
export function parseLiveCatalog(doc) {
  if (!doc || doc.code !== 0) return [];
  const byId = new Map((doc.data?.models ?? []).map((m) => [m.id, m]));
  const cliIds = (doc.data?.agents ?? []).find((a) => a.name === "cli")?.models ?? [];
  const live = [];
  for (const id of cliIds) {
    const m = byId.get(id);
    if (!m || m.disabled === true) continue;
    live.push({
      id: m.id,
      ctx: Number(m.maxInputTokens) || 200_000,
      out: Number(m.maxOutputTokens) || 32_000,
      img: m.supportsImages === true && m.disabledMultimodal !== true,
      efforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts
        : typeof m.reasoning?.effort === "string" ? [m.reasoning.effort] : undefined,
      canOff: m.reasoning?.canDisableThinking === true,
      displayName: typeof m.name === "string" && m.name ? m.name : undefined,
      creditMultiplier: parseCreditMultiplier(m.credits),
    });
  }
  return live;
}

/** 上游 `"x0.79 credits"` / `"x0.05"` → 0.79 / 0.05。 */
export function parseCreditMultiplier(raw) {
  if (typeof raw !== "string") return undefined;
  const m = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(raw);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** 拉上游实时目录；失败抛错，由调用方决定是否回落。 */
export async function fetchLiveModels(cred, { base = CN_CHAT_BASE, referer = CN_CHAT_BASE } = {}) {
  const response = await fetch(`${base}/console/enterprises/personal/models`, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: "application/json",
      Origin: referer,
      Referer: `${referer}/`,
      "User-Agent": CLIENT_UA,
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`upstream models http ${response.status}`);
  const doc = await response.json();
  const models = parseLiveCatalog(doc);
  if (models.length === 0) throw new Error("upstream returned no cli models");
  return models;
}

/**
 * Codex model_catalog_json 条目。
 *
 * 字段名与默认值来自 codex-cli 0.144+ 的实测样本：缺 `shell_type` /
 * `support_verbosity` / `truncation_policy` 会让 Codex 直接拒绝启动。
 */
function codexEntry(model, index) {
  const efforts = Array.isArray(model.efforts) && model.efforts.length ? model.efforts : ["medium"];
  return {
    slug: model.id,
    display_name: model.displayName ?? model.id,
    description: model.creditMultiplier === undefined
      ? "WorkBuddy model"
      : `WorkBuddy model · x${model.creditMultiplier.toFixed(2)} credits`,
    context_window: model.ctx,
    max_context_window: model.ctx,
    max_output_tokens: model.out,
    effective_context_window_percent: 95,
    default_reasoning_level: efforts.includes("high") ? "high" : efforts[0],
    default_reasoning_summary: "none",
    default_verbosity: "low",
    default_service_tier: null,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: EFFORT_LABELS[effort] ?? "Reasoning effort",
    })),
    supports_reasoning_summaries: true,
    reasoning_summary_format: "experimental",
    supports_parallel_tool_calls: true,
    supports_search_tool: false,
    supports_image_detail_original: false,
    input_modalities: model.img ? ["text", "image"] : ["text"],
    apply_patch_tool_type: "freeform",
    shell_type: "shell_command",
    support_verbosity: true,
    web_search_tool_type: "text",
    experimental_supported_tools: [],
    truncation_policy: { limit: 10000, mode: "tokens" },
    base_instructions: BASE_INSTRUCTIONS,
    model_messages: null,
    auto_compact_token_limit: null,
    auto_review_model_override: null,
    availability_nux: null,
    include_skills_usage_instructions: false,
    multi_agent_version: "v2",
    prefer_websockets: false,
    supported_in_api: true,
    use_responses_lite: false,
    visibility: "list",
    upgrade: null,
    tool_mode: null,
    priority: 1000 - index,
  };
}

/** 精简模型表 → Codex model_catalog_json 文档。 */
export function toCodexCatalog(models) {
  const list = Array.isArray(models) && models.length ? models : CN_FALLBACK_MODELS;
  return { models: list.map((m, i) => codexEntry(m, i)) };
}
