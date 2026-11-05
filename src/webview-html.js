"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readAsset(root, name) {
  try {
    return fs.readFileSync(path.join(root.fsPath, name), "utf8");
  } catch {
    return "";
  }
}

function nonce() {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function csp(webview, token) {
  return [
    "default-src 'none'",
    "img-src " + webview.cspSource,
    "style-src 'unsafe-inline'",
    "script-src 'nonce-" + token + "'",
  ].join("; ");
}

function pageBody() {
  return `<div class="card">
    <div class="row">
      <div id="statusDot" class="dot off"></div>
      <div class="grow">
        <div class="title">本地代理</div>
        <div id="statusText" class="sub">未启动</div>
      </div>
      <button id="btnStart" class="primary">启动</button>
      <button id="btnStop" class="ghost">停止</button>
    </div>
    <div class="row meta">
      <span id="portText">端口 —</span>
      <span id="pidText"></span>
      <span id="codexText" class="ellipsis"></span>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <div class="grow">
        <div class="title">剩余积分</div>
        <div id="creditTotal" class="big">—</div>
      </div>
      <button id="btnCredits" class="ghost">刷新</button>
    </div>
    <div id="creditDetail" class="sub"></div>
    <div id="creditPacks" class="packs"></div>
  </div>

  <div class="card">
    <div class="row">
      <div class="title grow">模型</div>
      <button id="btnConfig" class="ghost">打开配置</button>
      <button id="btnSync" class="ghost">写入 Codex</button>
    </div>
    <select id="modelSelect"></select>
    <div id="modelMeta" class="sub"></div>
  </div>

  <div id="error" class="error hidden"></div>

  <details class="card">
    <summary>日志</summary>
    <pre id="logs"></pre>
  </details>`;
}

/** 内联 CSS/JS，避免 webview 额外资源请求与 CSP 配置。 */
function renderHtml(webview, root) {
  const token = nonce();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp(webview, token)}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${readAsset(root, "panel.css")}</style>
</head>
<body>
  ${pageBody()}
  <script nonce="${token}">${readAsset(root, "panel.js")}</script>
</body>
</html>`;
}

module.exports = { renderHtml };
