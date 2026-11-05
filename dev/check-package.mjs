#!/usr/bin/env node
/**
 * Packaging guard: verifies that every file the extension manifest points at
 * exists in this repository, so a .vsix never ships with a dangling path.
 */
import { existsSync, readdirSync } from "node:fs";
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

/**
 * The extension must stay self-contained: everything it needs is packed, and it
 * never asks the user to install another project. Any runtime dependency edge
 * here would break the "install the vsix and it works" promise.
 */
const dependencyFields = ["dependencies", "peerDependencies", "extensionDependencies", "optionalDependencies"];
const declared = dependencyFields.filter((field) => {
  const value = pkg[field];
  return value && Object.keys(value).length > 0;
});
if (declared.length) {
  console.error(
    "[check-package] runtime dependencies are not allowed: " +
      declared.map((field) => `${field}=${JSON.stringify(pkg[field])}`).join(", ")
  );
  process.exit(1);
}

const bareImports = scanForBareImports(["src", "proxy"]);
if (bareImports.length) {
  console.error("[check-package] non-builtin imports found (must use node:* / relative):\n" + bareImports.join("\n"));
  process.exit(1);
}

console.log(`[check-package] ok: ${required.length} files present, 0 runtime dependencies (v${pkg.version})`);

/** Report import specifiers that are neither relative, node: builtins, nor vscode. */
function scanForBareImports(dirs) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(mjs|cjs|js)$/.test(entry.name)) continue;
      const text = readFileSync(join(root, rel), "utf8");
      for (const match of text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)) {
        const spec = match[1];
        if (spec.startsWith(".") || spec.startsWith("node:") || spec === "vscode") continue;
        hits.push(`${rel}: ${spec}`);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return hits;
}
