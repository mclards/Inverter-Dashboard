"use strict";

/**
 * Slice ε unit tests — inverter_stop_reasons_std schema migration
 *
 * Tests the creation and idempotency of the standard-Modbus stop-reasons
 * database table, including UNIQUE constraints and ensureColumn migrations.
 *
 * Related plan: plans/slice-epsilon-implementation.md §5
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// Test-only database file
const TEST_DB_PATH = path.join(__dirname, "testdb_std_migration.db");

function cleanTestDb() {
  try {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  } catch (err) {
    console.error(`Warning: could not clean test DB: ${err.message}`);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split("\n").slice(1, 3).join("\n"));
    }
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  dbStopReasonsStdMigration.test.js — Slice ε schema");
  console.log("──────────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────────────
  // Schema creation tests
  // ─────────────────────────────────────────────────────────────────────────

  test("create table inverter_stop_reasons_std with all columns", () => {
    cleanTestDb();
    const db = new Database(TEST_DB_PATH);

    // Create the table as per spec
    db.exec(`
      CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        inverter_id     INTEGER NOT NULL,
        inverter_ip     TEXT NOT NULL,
        slave           INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        timestamp_iso   TEXT NOT NULL,
        motive_code     INTEGER NOT NULL,
        motive_name     TEXT,
        read_at_ms      INTEGER NOT NULL,
        captured_at_ms  INTEGER,
        source          TEXT NOT NULL DEFAULT 'standard_modbus',
        updated_ts      INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
      );
      CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_iss_slot ON inverter_stop_reasons_std(inverter_ip, slave, slot);
    `);

    // Verify table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inverter_stop_reasons_std'").all();
    assert.strictEqual(tables.length, 1, "table should exist");

    // Verify all required columns exist
    const cols = db.prepare("PRAGMA table_info(inverter_stop_reasons_std)").all();
    const colNames = cols.map((c) => c.name);
    const required = [
      "id", "inverter_id", "inverter_ip", "slave", "slot",
      "timestamp_iso", "motive_code", "motive_name",
      "read_at_ms", "captured_at_ms", "source", "updated_ts",
    ];
    for (const col of required) {
      assert(colNames.includes(col), `column ${col} should exist`);
    }

    db.close();
    cleanTestDb();
  });

  test("UNIQUE constraint prevents duplicate (inverter_ip, slave, slot, timestamp_iso, motive_code)", () => {
    cleanTestDb();
    const db = new Database(TEST_DB_PATH);

    db.exec(`
      CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        inverter_id     INTEGER NOT NULL,
        inverter_ip     TEXT NOT NULL,
        slave           INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        timestamp_iso   TEXT NOT NULL,
        motive_code     INTEGER NOT NULL,
        motive_name     TEXT,
        read_at_ms      INTEGER NOT NULL,
        captured_at_ms  INTEGER,
        source          TEXT NOT NULL DEFAULT 'standard_modbus',
        updated_ts      INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
      );
    `);

    const insert = db.prepare(`
      INSERT INTO inverter_stop_reasons_std
      (inverter_id, inverter_ip, slave, slot, timestamp_iso, motive_code, motive_name, read_at_ms, captured_at_ms, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert first row
    insert.run(1, "192.168.1.10", 1, 0, "2026-01-15T10:30:45Z", 7, "MOTIVO_PARO_TEMPERATURA", 1000000, 1000000, "standard_modbus");

    // Attempt duplicate (should fail or upsert gracefully)
    try {
      insert.run(1, "192.168.1.10", 1, 0, "2026-01-15T10:30:45Z", 7, "MOTIVO_PARO_TEMPERATURA", 1000001, 1000000, "standard_modbus");
      // If we get here, the insert succeeded (allowed, or it was an UPSERT)
      // For this test, we expect the UNIQUE constraint to prevent duplicates
      throw new Error("duplicate insert should have failed");
    } catch (err) {
      // Expected: "UNIQUE constraint failed"
      assert(err.message.includes("UNIQUE"), "should enforce UNIQUE constraint");
    }

    db.close();
    cleanTestDb();
  });

  test("query by (inverter_ip, slave) returns expected rows", () => {
    cleanTestDb();
    const db = new Database(TEST_DB_PATH);

    db.exec(`
      CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        inverter_id     INTEGER NOT NULL,
        inverter_ip     TEXT NOT NULL,
        slave           INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        timestamp_iso   TEXT NOT NULL,
        motive_code     INTEGER NOT NULL,
        motive_name     TEXT,
        read_at_ms      INTEGER NOT NULL,
        captured_at_ms  INTEGER,
        source          TEXT NOT NULL DEFAULT 'standard_modbus',
        updated_ts      INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
      );
      CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
    `);

    const insert = db.prepare(`
      INSERT INTO inverter_stop_reasons_std
      (inverter_id, inverter_ip, slave, slot, timestamp_iso, motive_code, motive_name, read_at_ms, captured_at_ms, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert multiple rows
    insert.run(1, "192.168.1.10", 1, 0, "2026-01-15T10:30:45Z", 7, "MOTIVO_PARO_TEMPERATURA", 1000000, 1000000, "standard_modbus");
    insert.run(1, "192.168.1.10", 1, 1, "2026-01-15T10:30:40Z", 5, "MOTIVO_PARO_AISL_DC", 1000000, 999995000, "standard_modbus");
    insert.run(1, "192.168.1.10", 2, 0, "2026-01-15T09:20:30Z", 1, "MOTIVO_PARO_VIN", 999000, 999000000, "standard_modbus");
    insert.run(2, "192.168.1.11", 1, 0, "2026-01-15T08:15:25Z", 10, "MOTIVO_PARO_PARO_MANUAL", 998000, 998000000, "standard_modbus");

    // Query by (inverter_ip, slave)
    const query = db.prepare(`
      SELECT * FROM inverter_stop_reasons_std
      WHERE inverter_ip = ? AND slave = ?
      ORDER BY read_at_ms DESC
    `);

    const rows = query.all("192.168.1.10", 1);
    assert.strictEqual(rows.length, 2, "should return 2 rows for (192.168.1.10, slave=1)");
    assert.strictEqual(rows[0].motive_code, 7, "most recent should be code 7");
    assert.strictEqual(rows[1].motive_code, 5, "second should be code 5");

    db.close();
    cleanTestDb();
  });

  test("ensureColumn idempotency: running migration twice does not error", () => {
    cleanTestDb();
    const db = new Database(TEST_DB_PATH);

    // Create initial table (without motive_name)
    db.exec(`
      CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        inverter_id     INTEGER NOT NULL,
        inverter_ip     TEXT NOT NULL,
        slave           INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        timestamp_iso   TEXT NOT NULL,
        motive_code     INTEGER NOT NULL,
        read_at_ms      INTEGER NOT NULL,
        captured_at_ms  INTEGER,
        source          TEXT NOT NULL DEFAULT 'standard_modbus',
        updated_ts      INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
      );
    `);

    // Helper function (mirrors db.js pattern)
    function ensureColumn(tableName, columnName, columnDDL) {
      const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
      if (cols.some((c) => String(c?.name || "") === columnName)) return;
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDDL}`);
    }

    // Run migration twice
    ensureColumn("inverter_stop_reasons_std", "motive_name", "motive_name TEXT");
    ensureColumn("inverter_stop_reasons_std", "motive_name", "motive_name TEXT");  // Second time — should be idempotent

    // Verify column exists
    const cols = db.prepare("PRAGMA table_info(inverter_stop_reasons_std)").all();
    const hasMotiveName = cols.some((c) => c.name === "motive_name");
    assert.strictEqual(hasMotiveName, true, "motive_name should exist");

    db.close();
    cleanTestDb();
  });

  test("index creation succeeds", () => {
    cleanTestDb();
    const db = new Database(TEST_DB_PATH);

    db.exec(`
      CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        inverter_id     INTEGER NOT NULL,
        inverter_ip     TEXT NOT NULL,
        slave           INTEGER NOT NULL,
        slot            INTEGER NOT NULL,
        timestamp_iso   TEXT NOT NULL,
        motive_code     INTEGER NOT NULL,
        motive_name     TEXT,
        read_at_ms      INTEGER NOT NULL,
        captured_at_ms  INTEGER,
        source          TEXT NOT NULL DEFAULT 'standard_modbus',
        updated_ts      INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
        UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
      );
      CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_iss_slot ON inverter_stop_reasons_std(inverter_ip, slave, slot);
    `);

    // Verify indexes exist
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inverter_stop_reasons_std'").all();
    const indexNames = indexes.map((i) => i.name);
    assert(indexNames.includes("idx_iss_lookup"), "idx_iss_lookup should exist");
    assert(indexNames.includes("idx_iss_slot"), "idx_iss_slot should exist");

    db.close();
    cleanTestDb();
  });
}

run();
