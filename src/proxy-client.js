"use strict";

const http = require("node:http");

/**
 * 代理只监听 127.0.0.1，走 node:http 避免 fetch 连接池拖住 VS Code 退出。
 */
function request(port, method, urlPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

async function getJson(port, urlPath, timeoutMs) {
  const res = await request(port, "GET", urlPath, timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${urlPath} -> http ${res.status}: ${JSON.stringify(res.body)?.slice(0, 200)}`);
  }
  return res.body;
}

const health = (port, timeoutMs = 2500) => getJson(port, "/healthz", timeoutMs);
const models = (port) => getJson(port, "/w2c/models", 30000);
const credits = (port) => getJson(port, "/v1/credits", 30000);
const catalog = (port) => getJson(port, "/w2c/catalog", 30000);

module.exports = { request, getJson, health, models, credits, catalog };
