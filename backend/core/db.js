"use strict";
/**
 * db.js — Authoritative Database & Multi-Year Archive Layer for Inverter Dashboard 2.0
 *
 * Enforces 100% path isolation from legacy InverterDashboard (C:\ProgramData\InverterDashboard).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
let Database = null;
try { Database = require("better-sqlite3"); } catch (_) {}

function openDatabase(dbPath) {
  if (Database) {
    try {
      return new Database(dbPath, { timeout: 10000 });
    } catch (_) {}
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  if (!db.pragma) {
    db.pragma = function(pragmaStr) {
      try { return db.exec("PRAGMA " + pragmaStr); } catch (_) {}
    };
  }
  return db;
}

function resolveStoragePaths() {
  if (process.platform !== "win32") {
    // Linux standard paths for 2.0 (distinct from legacy /var/lib/adsi-dashboard)
    const linuxRoot = process.env.INVERTER_DATA_DIR || "/var/lib/inverter-dashboard";
    const dbDir = path.join(linuxRoot, "db");
    const archiveDir = path.join(dbDir, "archive");
    const configDir = path.join(linuxRoot, "config");
    const authDir = path.join(linuxRoot, "auth");
    const programDataDir = path.join(linuxRoot, "programdata");
    return { root: linuxRoot, dbDir, archiveDir, configDir, authDir, programDataDir };
  }

  // Windows standard paths:
  // If running inside packaged app.asar, use ProgramData; otherwise use local repo storage
  const isPackaged = __dirname.includes("app.asar") || (typeof process.resourcesPath === "string");
  const programDataRoot = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
  const packagedStorage = path.join(programDataRoot, "Inverter-Dashboard");
  const repoStorage = path.join(__dirname, "..", "..", "storage");

  const winRoot = process.env.INVERTER_DATA_DIR ||
    process.env.INVERTER_PORTABLE_DATA_DIR ||
    (isPackaged ? packagedStorage : repoStorage);

  const dbDir = path.join(winRoot, "db");
  const archiveDir = path.join(dbDir, "archive");
  const configDir = path.join(winRoot, "config");
  const authDir = path.join(winRoot, "auth");
  const programDataDir = path.join(winRoot, "programdata");
  return { root: winRoot, dbDir, archiveDir, configDir, authDir, programDataDir };
}

class DbManager {
  constructor() {
    this.paths = resolveStoragePaths();
    this._ensureDirs();
    this.dbPath = path.join(this.paths.dbDir, "inverter.db");
    this.db = openDatabase(this.dbPath);
    this._initPragmas();
    this._initCoreTables();
  }

  _ensureDirs() {
    [this.paths.dbDir, this.paths.archiveDir, this.paths.configDir, this.paths.authDir, this.paths.programDataDir]
      .forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });
  }

  _initPragmas() {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("temp_store = MEMORY");
  }

  _ensureColumn(tableName, columnName, columnDDL) {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
      if (!cols.some(c => String(c?.name || "").toLowerCase() === columnName.toLowerCase())) {
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDDL}`);
      }
    } catch (_) {}
  }

  _initCoreTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at_ts INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        operator TEXT DEFAULT 'OPERATOR',
        inverter INTEGER NOT NULL DEFAULT 0,
        node INTEGER DEFAULT 0,
        action TEXT NOT NULL,
        scope TEXT DEFAULT 'single',
        result TEXT DEFAULT 'ok',
        ip TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        target TEXT DEFAULT '',
        operator_name TEXT DEFAULT 'OPERATOR',
        device_id TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        details_json TEXT DEFAULT '{}'
      );
    `);

    this._ensureColumn("audit_log", "inverter", "inverter INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("audit_log", "ts", "ts INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("audit_log", "node", "node INTEGER DEFAULT 0");
    this._ensureColumn("audit_log", "operator", "operator TEXT DEFAULT 'OPERATOR'");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
      CREATE INDEX IF NOT EXISTS idx_audit_inv_ts ON audit_log(inverter, ts);

      CREATE TABLE IF NOT EXISTS plant_telemetry_5min (
        timestamp_ms INTEGER PRIMARY KEY,
        date TEXT,
        time_str TEXT,
        pac_kw REAL,
        daily_kwh REAL,
        total_kwh REAL,
        irradiance_wm2 REAL,
        ambient_temp_c REAL,
        inverter_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_date ON plant_telemetry_5min(date);
    `);
  }

  getSetting(key, fallback = null) {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ts = excluded.updated_at_ts
    `).run(key, String(value), now);
  }

  logAudit({ action, target = "", operatorName = "Operator", deviceId = "", ip = "127.0.0.1", details = {} }) {
    this.db.prepare(`
      INSERT INTO audit_log (timestamp_ms, action, target, operator_name, device_id, ip_address, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), action, target, operatorName, deviceId, ip, JSON.stringify(details));
  }

  getArchiveDb(monthKey) {
    // monthKey format: 'YYYY-MM'
    const archivePath = path.join(this.paths.archiveDir, `${monthKey}.db`);
    if (!fs.existsSync(archivePath)) return null;
    try {
      return new Database(archivePath, { readonly: true, timeout: 5000 });
    } catch (_) {
      return null;
    }
  }
}

module.exports = new DbManager();
