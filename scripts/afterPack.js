"use strict";
/**
 * afterPack.js — v2.8.10 power-loss resilience (Phase B2 / A3 companion)
 *
 * Runs after electron-builder packages app.asar but before NSIS wraps the
 * installer. Writes a SHA-512 sidecar manifest next to app.asar so the
 * runtime integrity gate (electron/integrityGate.js) can verify the bundle
 * on each launch.
 *
 * The manifest file is `app.asar.sha512` containing a single hex digest
 * line. It lives in the same resources directory as app.asar so an
 * atomic NSIS CopyFiles either replaces both or leaves both alone.
 *
 * Wire-up: package.json "build": { "afterPack": "scripts/afterPack.js" }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

async function hashFileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

module.exports = async function afterPack(context) {
  try {
    const resourcesPath = path.join(context.appOutDir, "resources");
    const asarPath = path.join(resourcesPath, "app.asar");
    if (!fs.existsSync(asarPath)) {
      console.log(`[afterPack] app.asar not found at ${asarPath}; skipping manifest`);
      return;
    }
    const stat = fs.statSync(asarPath);
    const digest = await hashFileStream(asarPath);
    const manifestPath = asarPath + ".sha512";
    fs.writeFileSync(manifestPath, `${digest}\n`, "utf8");
    console.log(
      `[afterPack] Wrote integrity manifest — size=${stat.size} ` +
      `sha512=${digest.slice(0, 16)}… -> ${manifestPath}`,
    );
  } catch (err) {
    console.error("[afterPack] FAILED to write integrity manifest:", err);
    throw err;
  }
};
