(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let state = null;

  function post(command, extra) {
    vscode.postMessage({ command, ...(extra || {}) });
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fmt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n * 100) / 100 + "";
  }

  function fmtDate(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (v) => String(v).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function renderStatus() {
    const busy = Boolean(state.busy);
    const dot = $("statusDot");
    dot.className = "dot " + (busy ? "busy" : state.running ? "on" : "off");
    $("statusText").textContent = busy
      ? (state.busy === "start" ? "启动中…" : state.busy === "stop" ? "停止中…" : "切换模型中…")
      : state.running
        ? "运行中 · 国内版 WorkBuddy"
        : "未启动";
    $("portText").textContent = "端口 " + state.port;
    $("pidText").textContent = state.pid ? "PID " + state.pid : "";
    $("codexText").textContent = state.codexConfig || "";
    $("codexText").title = state.codexConfig || "";
    $("btnStart").disabled = busy || state.running;
    $("btnStop").disabled = busy || !state.running;
    $("btnCredits").disabled = busy || !state.running;
    $("btnSync").disabled = busy;
    const err = $("error");
    if (state.error) {
      err.textContent = state.error;
      err.classList.remove("hidden");
    } else {
      err.classList.add("hidden");
    }
  }

  function renderCredits() {
    const credits = state.credits;
    if (!credits) {
      $("creditTotal").textContent = "—";
      $("creditDetail").textContent = state.running ? "尚未查询" : "启动代理后自动查询";
      $("creditPacks").innerHTML = "";
      return;
    }
    $("creditTotal").textContent = fmt(credits.total);
    const parts = [];
    if (credits.enterprise) parts.push("企业账号");
    if (credits.expiringSoon > 0) parts.push("72h 内到期 " + fmt(credits.expiringSoon));
    if (credits.updatedAt) parts.push("更新于 " + new Date(credits.updatedAt).toLocaleTimeString());
    $("creditDetail").textContent = parts.join(" · ");
    const packs = Array.isArray(credits.packages) ? credits.packages : [];
    $("creditPacks").innerHTML = packs.map((p) => {
      const remain = fmt(p.remain);
      const size = p.size ? " / " + fmt(p.size) : "";
      const when = p.monthly ? (p.refreshAtMs ? " · 重置 " + fmtDate(p.refreshAtMs) : " · 月度")
        : p.expiresAtMs ? " · 到期 " + fmtDate(p.expiresAtMs) : "";
      const soon = p.expiresAtMs && p.expiresAtMs - Date.now() < 72 * 3600 * 1000;
      return '<div class="pack' + (soon ? " expiring" : "") + '"><span class="name" title="' + esc(p.name) + '">' +
        esc(p.name) + when + '</span><span class="num">' + remain + size + "</span></div>";
    }).join("");
  }

  function renderModels() {
    const select = $("modelSelect");
    const models = Array.isArray(state.models) ? state.models : [];
    const current = state.selectedModel || "";
    const options = models.map((m) => {
      const label = (m.displayName || m.id) + (m.creditMultiplier != null ? "  x" + fmt(m.creditMultiplier) : "");
      return '<option value="' + esc(m.id) + '"' + (m.id === current ? " selected" : "") + ">" + esc(label) + "</option>";
    });
    if (!options.length) options.push('<option value="">（启动代理后加载模型）</option>');
    select.innerHTML = options.join("");
    const active = models.find((m) => m.id === current) || models[0];
    if (!current && active) select.value = active.id;
    $("modelMeta").textContent = active
      ? "上下文 " + Math.round((active.ctx || 0) / 1000) + "K · 输出 " + Math.round((active.out || 0) / 1000) + "K" +
        (active.efforts ? " · reasoning " + active.efforts.join("/") : "")
      : "";
  }

  function renderLogs() {
    const logs = Array.isArray(state.logs) ? state.logs : [];
    $("logs").textContent = logs.join("\n") || "（暂无日志）";
  }

  function render() {
    if (!state) return;
    renderStatus();
    renderCredits();
    renderModels();
    renderLogs();
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "state") {
      state = event.data.state;
      render();
    }
  });

  $("btnStart").addEventListener("click", () => post("start"));
  $("btnStop").addEventListener("click", () => post("stop"));
  $("btnCredits").addEventListener("click", () => post("refreshCredits"));
  $("btnSync").addEventListener("click", () => post("syncCodex"));
  $("btnConfig").addEventListener("click", () => post("openConfig"));
  $("modelSelect").addEventListener("change", (event) => post("selectModel", { model: event.target.value }));
  post("ready");
})();
