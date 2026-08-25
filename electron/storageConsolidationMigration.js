"use strict";
/**
 * storageConsolidationMigration.js — One-time storage consolidation migration.
 *
 * Runs during the Electron loading screen (before startServer()).
 * Copies app data from the legacy scattered layout to the unified root:
 *
 *   %APPDATA%\Inverter-Dashboard\            → %PROGRAMDATA%\InverterDashboard\db\
 *   %APPDATA%\Inverter-Dashboard\archive\    → %PROGRAMDATA%\InverterDashboard\archive\
 *   %APPDATA%\Inverter-Dashboard\cloud_backups\ → %PROGRAMDATA%\InverterDashboard\cloud_backups\
 *   %APPDATA%\Inverter-Dashboard\cloud_tokens.enc → %PROGRAMDATA%\InverterDashboard\auth\
 *   %APPDATA%\Inverter-Dashboard\[config\]ipconfig.json → %PROGRAMDATA%\InverterDashboard\db\
 *   %PROGRAMDATA%\ADSI-InverterDashboard\license\ → %PROGRAMDATA%\InverterDashboard\license\
 *
 * Safety guarantees:
 *  - Version-gated: runs only once per version (sentinel .json file).
 *  - Non-blocking: errors are logged but never crash the app.
 *  - Crash-safe: sentinel is only written after all copies succeed.
 *  - Zero deletion: old files are NEVER deleted.
 *  - Portable: skips entirely when portable-mode env vars are set.
 */

const fs   = require("fs");
const path = require("path");
const {
  MIGRATION_VERSION,
  NEW_ROOT,
  NEW_DB_DIR,
  NEW_ARCHIVE_DIR,
  NEW_CONFIG_DIR,
  NEW_BACKUP_DIR,
  NEW_AUTH_DIR,
  NEW_LICENSE_DIR,
  OLD_APPDATA_DIR,
  OLD_LEGACY_DIR,
  OLD_LICENSE_DIR,
  MIGRATION_STATE_FILE,
} = require("./storageConsolidationPaths");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Grant BUILTIN\Users modify access to a directory (and children via /T).
 * Required because %PROGRAMDATA% inherits restrictive ACLs where
 * Users only get Read & Execute — which makes SQLite open the DB read-only
 * when the app runs without elevation.
 */
function grantUsersWriteAccess(dirPath) {
  if (process.platform !== "win32") return;
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("icacls", [dirPath, "/grant", "Users:(OI)(CI)M", "/T", "/Q"], {
      windowsHide: true,
      timeout: 15000,
    });
    if (r.error) throw r.error;
  } catch (err) {
    console.warn("[migration] Could not grant Users write access to", dirPath, ":", err.message);
  }
}

function readState() {
  try {
    if (!fs.existsSync(MIGRATION_STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(MIGRATION_STATE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

/** Write migration sentinel. Returns true on success, false on failure. */
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(MIGRATION_STATE_FILE), { recursive: true });
    fs.writeFileSync(MIGRATION_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[migration] FAILED to write migration sentinel:", err.message,
      "— migration will re-run on next boot (safe but slow)");
    return false;
  }
}

/**
 * Copy a single file src → dst.
 * Skips if dst already exists (idempotent).
 * Pushes a string to errors[] on failure.
 */
function copyFileSafe(src, dst, errors) {
  try {
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) return; // already done
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } catch (err) {
    const msg = `copy ${src} → ${dst}: ${err.message}`;
    errors.push(msg);
    console.warn("[migration]", msg);
  }
}

/**
 * Recursively copy a directory srcDir → dstDir.
 * Skips individual files that already exist at destination.
 */
function copyDirSafe(srcDir, dstDir, errors) {
  if (!srcDir || !fs.existsSync(srcDir)) return;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);
      if (entry.isSymbolicLink()) {
        // Resolve symlink target and copy as a regular file/dir
        try {
          const realSrc = fs.realpathSync(src);
          const stat = fs.statSync(realSrc);
          if (stat.isDirectory()) copyDirSafe(realSrc, dst, errors);
          else if (stat.isFile()) copyFileSafe(realSrc, dst, errors);
        } catch (err) {
          errors.push(`symlink ${src}: ${err.message}`);
        }
      } else if (entry.isDirectory()) {
        copyDirSafe(src, dst, errors);
      } else if (entry.isFile()) {
        copyFileSafe(src, dst, errors);
      }
    }
  } catch (err) {
    const msg = `copyDir ${srcDir} → ${dstDir}: ${err.message}`;
    errors.push(msg);
    console.warn("[migration]", msg);
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Execute the storage consolidation migration.
 * Safe to call every boot — skips immediately if already done.
 */
async function runStorageMigration() {
  // Skip in portable mode (already has clean layout).
  if (
    process.env.PORTABLE_EXECUTABLE_DIR ||
    process.env.IM_PORTABLE_DATA_DIR    ||
    process.env.ADSI_PORTABLE_DATA_DIR
  ) {
    return;
  }

  // Skip if explicit data-dir override is active (admin-configured path).
  if (process.env.IM_DATA_DIR || process.env.ADSI_DATA_DIR) {
    return;
  }

  // Check migration sentinel.
  const state = readState();
  if (state.status === "complete" && state.version === MIGRATION_VERSION) {
    return; // Already done.
  }

  // On a fresh install the old APPDATA dir won't exist — nothing to migrate.
  const oldExists = fs.existsSync(OLD_APPDATA_DIR) || fs.existsSync(OLD_LEGACY_DIR);
  const licenseOldExists = fs.existsSync(OLD_LICENSE_DIR);

  if (!oldExists && !licenseOldExists) {
    writeState({
      version: MIGRATION_VERSION,
      status: "complete",
      reason: "fresh-install",
      completedAt: Date.now(),
    });
    return;
  }

  console.log("[migration] Running storage consolidation v" + MIGRATION_VERSION);
  writeState({ version: MIGRATION_VERSION, status: "in-progress", startedAt: Date.now() });

  // Ensure new root directory tree exists.
  for (const dir of [NEW_ROOT, NEW_DB_DIR, NEW_ARCHIVE_DIR, NEW_CONFIG_DIR,
                     NEW_BACKUP_DIR, NEW_AUTH_DIR, NEW_LICENSE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }

  // Grant Users modify access so the app works without elevation.
  grantUsersWriteAccess(NEW_ROOT);

  const errors = [];

  // ── 1. Main database files ─────────────────────────────────────────────────
  for (const f of [
    "adsi.db",
    "adsi.db-wal",
    "adsi.db-shm",
    ".pending-main-db-replacement.json",
    ".pending-archive-replacements.json",
  ]) {
    copyFileSafe(path.join(OLD_APPDATA_DIR, f), path.join(NEW_DB_DIR, f), errors);
  }

  // ── 2. Archive databases ───────────────────────────────────────────────────
  copyDirSafe(path.join(OLD_APPDATA_DIR, "archive"), NEW_ARCHIVE_DIR, errors);

  // ── 3. Cloud backups + history ─────────────────────────────────────────────
  copyDirSafe(path.join(OLD_APPDATA_DIR, "cloud_backups"), NEW_BACKUP_DIR, errors);
  copyFileSafe(
    path.join(OLD_APPDATA_DIR, "backup_history.json"),
    path.join(NEW_ROOT, "backup_history.json"),
    errors,
  );

  // ── 4. Encrypted cloud tokens ──────────────────────────────────────────────
  copyFileSafe(
    path.join(OLD_APPDATA_DIR, "cloud_tokens.enc"),
    path.join(NEW_AUTH_DIR, "cloud_tokens.enc"),
    errors,
  );

  // ── 5. ipconfig.json (copy alongside DB — all services expect db/ipconfig.json)
  const ipconfigDst = path.join(NEW_DB_DIR, "ipconfig.json");
  if (!fs.existsSync(ipconfigDst)) {
    const candidates = [
      path.join(OLD_APPDATA_DIR, "config", "ipconfig.json"),
      path.join(OLD_APPDATA_DIR, "ipconfig.json"),
    ];
    for (const src of candidates) {
      if (fs.existsSync(src)) {
        copyFileSafe(src, ipconfigDst, errors);
        break;
      }
    }
  }

  // ── 6. License files (from separate ADSI-InverterDashboard namespace) ──────
  copyDirSafe(OLD_LICENSE_DIR, NEW_LICENSE_DIR, errors);

  // ── 7. Write sentinel ─────────────────────────────────────────────────────
  const sentinelOk = writeState({
    version: MIGRATION_VERSION,
    status: errors.length ? "completed-with-errors" : "complete",
    completedAt: Date.now(),
    errors: errors.length ? errors : undefined,
  });

  if (!sentinelOk) {
    errors.push("sentinel write failed — migration will re-run on next boot");
  }

  if (errors.length) {
    console.warn(`[migration] Completed with ${errors.length} non-fatal error(s):`, errors);
  } else {
    console.log("[migration] Storage consolidation complete.");
  }
}

module.exports = { runStorageMigration };
