// server/calibratorDb.js — standalone calibrator SQLite database
//
// Provides a dedicated better-sqlite3 instance for the calibrator server.
// Tables and persisters mirror server/db.js (copied DDL from server/db.js
// lines 637-648, 1181-1230) to avoid schema drift. This db does NOT contain
// fleet inverter readings, alarm history, or forecast data — only calibration
// records required by calibrationRoutes.js.
//
// DDL SOURCE MAPPING (keep in sync with server/db.js):
//   • audit_log            — server/db.js lines 637–648
//   • calibration_write_log — server/db.js lines 1181–1200
//   • calibration_snapshot  — server/db.js lines 1202–1218
//   • calibration_session_log — server/db.js lines 1220–1231

"use strict";

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

let db = null;

function initCalibratorDb(dbPath) {
  const resolved = path.resolve(dbPath);
  // First-run: the calibrator data dir (e.g. <APPDATA>/.calibrator) does not
  // exist yet — better-sqlite3 throws "directory does not exist" without this.
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (err) {
    if (err && err.code !== "EEXIST") throw err;
  }
  console.log(`[calibrator-db] opening ${resolved}`);

  db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Create calibration tables if not exist. DDL copied from server/db.js
  // to lock the schema contract.

  // audit_log (server/db.js lines 637–648)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      operator  TEXT DEFAULT 'OPERATOR',
      inverter  INTEGER NOT NULL,
      node      INTEGER DEFAULT 0,
      action    TEXT NOT NULL,
      scope     TEXT DEFAULT 'single',
      result    TEXT DEFAULT 'ok',
      ip        TEXT DEFAULT '',
      reason    TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_inv_ts ON audit_log(inverter, ts);
  `);

  // calibration_write_log (server/db.js lines 1181–1200)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_write_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_utc          INTEGER NOT NULL,
      session_id      TEXT    NOT NULL,
      inverter_id     INTEGER NOT NULL,
      inverter_ip     TEXT    NOT NULL,
      slave           INTEGER NOT NULL,
      reg_offset      INTEGER NOT NULL,
      param_name      TEXT    NOT NULL,
      value_before    INTEGER,
      value_requested INTEGER NOT NULL,
      value_after     INTEGER,
      verify_ok       INTEGER NOT NULL DEFAULT 0,
      operator        TEXT,
      auth_method     TEXT,
      error_detail    TEXT,
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cwl_session ON calibration_write_log(session_id, ts_utc);
    CREATE INDEX IF NOT EXISTS idx_cwl_inv_ts  ON calibration_write_log(inverter_id, slave, ts_utc DESC);
  `);

  // calibration_snapshot (server/db.js lines 1202–1218)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_snapshot (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_utc            INTEGER NOT NULL,
      inverter_id       INTEGER NOT NULL,
      inverter_ip       TEXT    NOT NULL,
      slave             INTEGER NOT NULL,
      source            TEXT    NOT NULL,
      session_id        TEXT,
      reg_block_hex     TEXT    NOT NULL,
      valid_cfg_code    INTEGER,
      model_code        TEXT,
      firmware_main     TEXT,
      serial            TEXT,
      notes             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_csnap_inv_ts ON calibration_snapshot(inverter_id, slave, ts_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_csnap_session ON calibration_snapshot(session_id);
  `);

  // calibration_session_log (server/db.js lines 1220–1231)
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_session_log (
      session_id        TEXT    PRIMARY KEY,
      inverter_id       INTEGER NOT NULL,
      slave             INTEGER NOT NULL,
      operator          TEXT,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER,
      end_reason        TEXT,
      write_count       INTEGER NOT NULL DEFAULT 0,
      consign_writes    INTEGER NOT NULL DEFAULT 0,
      notes             TEXT
    );
  `);

  // settings table for getSetting/setSetting
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT,
      ts    INTEGER
    );
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error("[calibrator-db] database not initialized — call initCalibratorDb first");
  return db;
}

// ── Persisters (mirror server/db.js contract) ──────────────────────────

function insertAuditLogRow({
  ts,
  operator = "SYSTEM",
  inverter = 0,
  node = 0,
  action = "",
  scope = "single",
  result = "ok",
  ip = "",
  reason = "",
} = {}) {
  try {
    getDb().prepare(
      `INSERT INTO audit_log
         (ts, operator, inverter, node, action, scope, result, ip, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(ts) || Date.now(),
      String(operator),
      Math.trunc(Number(inverter) || 0),
      Math.trunc(Number(node) || 0),
      String(action),
      String(scope),
      String(result),
      String(ip),
      String(reason),
    );
    return true;
  } catch (err) {
    console.warn("[audit_log] insert failed:", err && err.message);
    return false;
  }
}

function insertCalibrationSnapshot(row) {
  const r = row || {};
  return getDb().prepare(`
    INSERT INTO calibration_snapshot
      (ts_utc, inverter_id, inverter_ip, slave, source, session_id,
       reg_block_hex, valid_cfg_code, model_code, firmware_main, serial, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(r.ts_utc) || Date.now(),
    Number(r.inverter_id),
    String(r.inverter_ip || ""),
    Number(r.slave),
    String(r.source || "baseline"),
    r.session_id == null ? null : String(r.session_id),
    String(r.reg_block_hex || ""),
    r.valid_cfg_code == null ? null : Number(r.valid_cfg_code),
    r.model_code == null ? null : String(r.model_code),
    r.firmware_main == null ? null : String(r.firmware_main),
    r.serial == null ? null : String(r.serial),
    r.notes == null ? null : String(r.notes),
  ).lastInsertRowid;
}

function getLatestCalibrationSnapshot(inverter_id, slave) {
  return getDb().prepare(`
    SELECT * FROM calibration_snapshot
     WHERE inverter_id = ? AND slave = ?
     ORDER BY ts_utc DESC LIMIT 1
  `).get(Number(inverter_id), Number(slave)) || null;
}

function listCalibrationSnapshots(inverter_id, slave, limit) {
  return getDb().prepare(`
    SELECT * FROM calibration_snapshot
     WHERE inverter_id = ? AND slave = ?
     ORDER BY ts_utc DESC LIMIT ?
  `).all(Number(inverter_id), Number(slave),
        Math.min(100, Math.max(1, Number(limit) || 20)));
}

function getCalibrationSnapshotById(id) {
  return getDb().prepare(`
    SELECT * FROM calibration_snapshot WHERE id = ?
  `).get(Number(id)) || null;
}

function deleteCalibrationSnapshotById(id) {
  return getDb().prepare(`
    DELETE FROM calibration_snapshot WHERE id = ?
  `).run(Number(id)).changes;
}

function insertCalibrationWriteLog(row) {
  const r = row || {};
  return getDb().prepare(`
    INSERT INTO calibration_write_log
      (ts_utc, session_id, inverter_id, inverter_ip, slave, reg_offset,
       param_name, value_before, value_requested, value_after,
       verify_ok, operator, auth_method, error_detail, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(r.ts_utc) || Date.now(),
    String(r.session_id || ""),
    Number(r.inverter_id),
    String(r.inverter_ip || ""),
    Number(r.slave),
    Number(r.reg_offset),
    String(r.param_name || ""),
    r.value_before == null ? null : Number(r.value_before),
    Number(r.value_requested),
    r.value_after == null ? null : Number(r.value_after),
    r.verify_ok ? 1 : 0,
    r.operator == null ? null : String(r.operator),
    r.auth_method == null ? null : String(r.auth_method),
    r.error_detail == null ? null : String(r.error_detail),
    r.notes == null ? null : String(r.notes),
  ).lastInsertRowid;
}

function listCalibrationWriteLog(filters) {
  const f = filters || {};
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100));
  if (f.session_id) {
    return getDb().prepare(`
      SELECT * FROM calibration_write_log
       WHERE session_id = ? ORDER BY ts_utc DESC LIMIT ?
    `).all(String(f.session_id), limit);
  }
  if (Number.isInteger(Number(f.inverter_id))) {
    return getDb().prepare(`
      SELECT * FROM calibration_write_log
       WHERE inverter_id = ? ${f.slave ? "AND slave = ?" : ""}
       ORDER BY ts_utc DESC LIMIT ?
    `).all(...(f.slave
      ? [Number(f.inverter_id), Number(f.slave), limit]
      : [Number(f.inverter_id), limit]));
  }
  return getDb().prepare(`
    SELECT * FROM calibration_write_log
     ORDER BY ts_utc DESC LIMIT ?
  `).all(limit);
}

function insertCalibrationSession(row) {
  const r = row || {};
  return getDb().prepare(`
    INSERT OR REPLACE INTO calibration_session_log
      (session_id, inverter_id, slave, operator, started_at_ms,
       ended_at_ms, end_reason, write_count, consign_writes, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(r.session_id),
    Number(r.inverter_id),
    Number(r.slave),
    r.operator == null ? null : String(r.operator),
    Number(r.started_at_ms) || Date.now(),
    r.ended_at_ms == null ? null : Number(r.ended_at_ms),
    r.end_reason == null ? null : String(r.end_reason),
    Number(r.write_count) || 0,
    Number(r.consign_writes) || 0,
    r.notes == null ? null : String(r.notes),
  );
}

function updateCalibrationSessionEnd(session_id, end_reason, counts) {
  const c = counts || {};
  return getDb().prepare(`
    UPDATE calibration_session_log
       SET ended_at_ms    = ?,
           end_reason     = ?,
           write_count    = COALESCE(?, write_count),
           consign_writes = COALESCE(?, consign_writes),
           notes          = COALESCE(?, notes)
     WHERE session_id = ?
  `).run(
    Date.now(),
    String(end_reason || "operator"),
    c.write_count == null ? null : Number(c.write_count),
    c.consign_writes == null ? null : Number(c.consign_writes),
    c.notes == null ? null : String(c.notes),
    String(session_id),
  ).changes;
}

function getCalibrationSession(session_id) {
  return getDb().prepare(
    `SELECT * FROM calibration_session_log WHERE session_id = ?`,
  ).get(String(session_id)) || null;
}

function listRecentCalibrationSessions(limit) {
  return getDb().prepare(`
    SELECT * FROM calibration_session_log
     ORDER BY started_at_ms DESC LIMIT ?
  `).all(Math.min(100, Math.max(1, Number(limit) || 20)));
}

function getSetting(key, def = null) {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  getDb().prepare(`INSERT OR REPLACE INTO settings (key, value, ts) VALUES (?, ?, ?)`).run(
    key, String(value), Date.now(),
  );
}

function close() {
  if (db) {
    // Graceful close contract (mirrors server/db.js closeDb): TRUNCATE-
    // checkpoint the WAL into the main file so the DB is left as a single
    // consistent file, then release the handle. Both best-effort and
    // idempotent — `db` is nulled so a second call (signal path + the
    // process 'exit' net) is a safe no-op.
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (_) { /* best-effort on shutdown */ }
    try { db.close(); } catch (_) { /* ignore double-close / close races */ }
    db = null;
  }
}

module.exports = {
  initCalibratorDb,
  getDb,
  close,
  // Persisters
  insertAuditLogRow,
  insertCalibrationSnapshot,
  getLatestCalibrationSnapshot,
  listCalibrationSnapshots,
  getCalibrationSnapshotById,
  deleteCalibrationSnapshotById,
  insertCalibrationWriteLog,
  listCalibrationWriteLog,
  insertCalibrationSession,
  updateCalibrationSessionEnd,
  getCalibrationSession,
  listRecentCalibrationSessions,
  getSetting,
  setSetting,
};
