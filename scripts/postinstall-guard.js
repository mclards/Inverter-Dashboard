#!/usr/bin/env node
/**
 * scripts/postinstall-guard.js
 *
 * Cross-platform postinstall guard.
 *
 * On Windows / macOS (Electron desktop builds):
 *   Runs `electron-builder install-app-deps` to compile native addons
 *   (better-sqlite3, etc.) against the bundled Electron ABI.
 *
 * On Linux headless server (npm install --omit=dev):
 *   Skips electron-builder entirely. The `electron` devDependency is not
 *   installed, so calling electron-builder would crash. On Linux, native
 *   addons are compiled against the system Node.js ABI via:
 *     npm rebuild better-sqlite3
 *   which is handled by deploy/linux/setup.sh.
 *
 * Detection logic:
 *   - If `electron` package is resolvable in node_modules → Electron context
 *   - Otherwise (--omit=dev, Linux headless) → skip gracefully
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Check if electron devDependency is actually installed (skipped with --omit=dev)
const electronBinPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "package.json",
);

if (!fs.existsSync(electronBinPath)) {
  // Linux headless install or --omit=dev — skip Electron native rebuild
  console.log(
    "[postinstall] electron devDependency not found — skipping electron-builder install-app-deps (Linux headless mode).",
  );
  process.exit(0);
}

// Electron is present — run the normal Windows/macOS native rebuild
console.log("[postinstall] electron devDependency found — running electron-builder install-app-deps...");
try {
  execSync("electron-builder install-app-deps", { stdio: "inherit" });
} catch (err) {
  // Non-fatal: warn but don't block npm install completion
  console.warn("[postinstall] electron-builder install-app-deps failed (non-fatal):", err.message);
  process.exit(0);
}

