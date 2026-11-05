#!/usr/bin/env node
/**
 * Packaging guard: verifies that every file the extension manifest points at
 * exists in this repository, so a .vsix never ships with a dangling path.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const required = [
  pkg.main,
  "proxy/proxy.mjs",
  "proxy/shared/index.mjs",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
];

for (const icon of pkg.contributes?.viewsContainers?.activitybar ?? []) {
  if (icon.icon) required.push(icon.icon);
}

// Marketplace / extension-list icon declared at the manifest root.
if (pkg.icon) required.push(pkg.icon);

const missing = required.filter((rel) => !existsSync(join(root, rel)));
if (missing.length) {
  console.error("[check-package] missing files:\n" + missing.join("\n"));
  process.exit(1);
}

console.log(`[check-package] ok: ${required.length} files present (v${pkg.version})`);
