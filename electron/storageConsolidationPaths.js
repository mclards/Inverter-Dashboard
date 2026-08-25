"use strict";
/**
 * storageConsolidationPaths.js — Path constants for the v2.4.43 storage migration.
 *
 * Single source of truth for old vs new storage locations.
 * Used exclusively by storageConsolidationMigration.js.
 */

const path = require("path");
const os   = require("os");

const MIGRATION_VERSION    = "2.4.43";
const PROGRAMDATA_ROOT     = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
const APPDATA_ROOT         = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

// ── New unified root ──────────────────────────────────────────────────────────
const NEW_ROOT         = path.join(PROGRAMDATA_ROOT, "Inverter-Dashboard");
const NEW_DB_DIR       = path.join(NEW_ROOT, "db");
const NEW_ARCHIVE_DIR  = path.join(NEW_ROOT, "archive");
const NEW_CONFIG_DIR   = path.join(NEW_ROOT, "config");
const NEW_BACKUP_DIR   = path.join(NEW_ROOT, "cloud_backups");
const NEW_AUTH_DIR     = path.join(NEW_ROOT, "auth");
const NEW_LICENSE_DIR  = path.join(NEW_ROOT, "license");

// ── Legacy paths (pre-consolidation) ─────────────────────────────────────────
const OLD_APPDATA_DIR   = path.join(APPDATA_ROOT, "Inverter-Dashboard");
const OLD_LEGACY_DIR    = path.join(APPDATA_ROOT, "ADSI-Dashboard");          // pre-v2.x rename
const OLD_LICENSE_DIR   = path.join(PROGRAMDATA_ROOT, "ADSI-InverterDashboard", "license");

// ── Migration state sentinel file ─────────────────────────────────────────────
const MIGRATION_STATE_FILE = path.join(NEW_ROOT, ".adsi-migration-v2.4.43.json");

module.exports = {
  MIGRATION_VERSION,
  PROGRAMDATA_ROOT,
  APPDATA_ROOT,
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
};
