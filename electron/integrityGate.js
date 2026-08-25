"use strict";
/**
 * integrityGate.js — power-loss resilience (Phase A3)
 *
 * WHY: After a sudden Windows shutdown (power loss, hard reset, kernel panic),
 * NTFS can leave files under C:\Program Files in a torn state — metadata says
 * "n bytes" but data blocks contain stale/garbage bytes. Electron then dies at
 * require() time with `SyntaxError: Unexpected token '` when JSON.parse hits
 * the corrupt bytes inside app.asar's embedded package.json files.
 *
 * WHAT: Verifies the packaged app.asar against a SHA-512 sidecar manifest
 * written by the NSIS/electron-builder post-build hook. If the hash does not
 * match, the caller surfaces a recovery dialog instead of letting Electron's
 * default fatal handler show a cryptic SyntaxError.
 *
 * COST: Hashing a ~500 MB asar takes 2-4 s on spinning rust, <1 s on SSD.
 * To avoid paying that on every boot, we only run the expensive check when
 * `wasDirtyShutdown()` returns true. Otherwise a fast size + header check runs
 * and we trust the OS.
 *
 * SECURITY: This is a reliability gate, not a tamper-detection gate.
 * Authenticode signing + electron-updater's SHA-512 remain the primary
 * anti-tamper defences. This module only catches accidental corruption.
 *
 * v2.8.11 FIX — Electron asar virtualization
 * ------------------------------------------
 * This module runs from INSIDE app.asar once the app is packaged. Electron
 * intercepts all `fs` calls coming from code that lives inside an asar
 * archive and makes the asar itself appear as a *directory*. When we do
 * `fs.statSync("…/app.asar")`, Electron returns synthetic Stats where
 * `isDirectory()` is true and `size` is 0 (Windows's usual "size of a
 * directory" result). That false-0 tripped the `size < 64` branch below
 * on EVERY launch of a packaged v2.8.10 install — even when app.asar was
 * actually 475 MB on disk.
 *
 * FIX: use `original-fs` (shipped with Electron) which exposes the raw,
 * un-shimmed filesystem. Fall back to the standard `fs` module for
 * non-Electron environments (unit tests under plain Node) since there
 * the shim doesn't exist anyway.
 *
 * DEPENDENCIES: Node core only (original-fs / fs, path, crypto,
 * child_process). MUST NOT require any third-party module — those live
 * inside app.asar and are exactly what we're trying to validate.
 */

// v2.8.11: original-fs bypasses Electron's asar shim so fs.statSync returns
// the real on-disk size of app.asar instead of a synthetic directory Stats
// object with size=0. In a non-Electron context (tests), require will throw
// and we fall back to stock fs which doesn't have the shim to begin with.
let fs;
try {
  fs = require("original-fs");
} catch (_) {
  fs = require("fs");
}
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const MANIFEST_SUFFIX = ".sha512";
const HEADER_MAGIC = Buffer.from([0x04, 0x00, 0x00, 0x00]);

function safeReadSync(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    return null;
  }
}

function hashFileSync(filePath) {
  const hash = crypto.createHash("sha512");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
  return hash.digest("hex");
}

function fastHeaderCheck(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    return header.equals(HEADER_MAGIC);
  } catch (_) {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

/**
 * Returns true if Windows rebooted unexpectedly since the last normal boot.
 * Uses wevtutil to query event ID 41 (Kernel-Power unexpected shutdown) and
 * event ID 6008 (unexpected shutdown) from the System log in the last 24 h.
 *
 * Gracefully returns false if wevtutil is unavailable (non-Windows, missing
 * permissions) — we'd rather skip the expensive hash than fail-open.
 */
function wasDirtyShutdown() {
  if (process.platform !== "win32") return false;
  try {
    const query = "*[System[(EventID=41 or EventID=6008) and TimeCreated[timediff(@SystemTime) <= 86400000]]]";
    const out = execFileSync(
      "wevtutil",
      ["qe", "System", "/c:1", "/rd:true", "/f:text", `/q:${query}`],
      { timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    return String(out || "").trim().length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Primary entry: verify app.asar integrity.
 *
 * Returns:
 *   { ok: true, mode: "skipped" | "fast" | "full", asarPath, details }
 *   { ok: false, mode, asarPath, reason, details }
 *
 * The caller uses `ok` to decide whether to show the recovery dialog.
 *
 * Defensive: if we get any hint that the fs we're using is still the
 * Electron-shimmed one (synthetic Stats on the asar), we degrade to
 * `skipped` rather than falsely claim corruption. Crashing a healthy
 * install is a worse failure mode than missing a rare torn-write event.
 */
function verifyAsarIntegrity({ resourcesPath, forceFull = false } = {}) {
  const rp = String(resourcesPath || process.resourcesPath || "").trim();
  const asarPath = path.join(rp, "app.asar");
  const manifestPath = asarPath + MANIFEST_SUFFIX;

  const asarStat = safeStat(asarPath);
  if (!asarStat) {
    return {
      ok: false,
      mode: "full",
      asarPath,
      reason: "app.asar missing",
      details: {},
    };
  }

  // v2.8.11 defensive guard: if stat says the asar is a directory, we're
  // reading through Electron's virtualized fs (original-fs fallback failed
  // or some other layer is shimming). Skip the size/hash checks — we
  // cannot trust them and must not show the recovery dialog.
  if (typeof asarStat.isDirectory === "function" && asarStat.isDirectory()) {
    return {
      ok: true,
      mode: "skipped",
      asarPath,
      reason: "fs layer reports asar as directory — skipping (original-fs unavailable?)",
      details: { size: asarStat.size, viaShimmedFs: true },
    };
  }

  if (asarStat.size < 64) {
    return {
      ok: false,
      mode: "full",
      asarPath,
      reason: `app.asar suspiciously small (${asarStat.size} bytes)`,
      details: { size: asarStat.size },
    };
  }

  if (!fastHeaderCheck(asarPath)) {
    return {
      ok: false,
      mode: "full",
      asarPath,
      reason: "app.asar header is invalid",
      details: { size: asarStat.size },
    };
  }

  const manifest = safeReadSync(manifestPath);
  if (!manifest) {
    return {
      ok: true,
      mode: "skipped",
      asarPath,
      reason: "no manifest (pre-2.8.11 install)",
      details: { size: asarStat.size },
    };
  }

  const expected = manifest.toString("utf8").trim().toLowerCase().split(/\s+/)[0] || "";
  if (!/^[0-9a-f]{128}$/.test(expected)) {
    return {
      ok: true,
      mode: "skipped",
      asarPath,
      reason: "manifest malformed — skipping check",
      details: { size: asarStat.size },
    };
  }

  const runFull = forceFull || wasDirtyShutdown();
  if (!runFull) {
    return {
      ok: true,
      mode: "fast",
      asarPath,
      reason: "no dirty shutdown detected — fast path",
      details: { size: asarStat.size },
    };
  }

  const actual = hashFileSync(asarPath).toLowerCase();
  if (actual === expected) {
    return {
      ok: true,
      mode: "full",
      asarPath,
      reason: "hash verified",
      details: { size: asarStat.size, expected, actual },
    };
  }

  return {
    ok: false,
    mode: "full",
    asarPath,
    reason: "hash mismatch — app.asar is corrupt",
    details: { size: asarStat.size, expected, actual },
  };
}

module.exports = {
  verifyAsarIntegrity,
  wasDirtyShutdown,
  hashFileSync,
};
