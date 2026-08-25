"use strict";

/**
 * Phase 1 Integration Tests: IGBT Fleet Endpoints
 *
 * Tests the three REST endpoints:
 *   - GET /api/igbt/fleet
 *   - GET /api/igbt/node/:inverter/:slave
 *   - GET /api/igbt/fleet.csv
 *
 * Uses a minimal temporary SQLite instance with seeded fixtures.
 *
 * Related plan: plans/igbt-health-phase1.md §9, §11.3
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// Helper: create a minimal test database with fixtures
function createTestDb() {
  const tmpPath = path.join(__dirname, "..", "tests", ".igbt-test-db.db");

  // Clean up any stale instance
  try {
    fs.unlinkSync(tmpPath);
  } catch (_) {}

  const db = new Database(tmpPath);

  // Create inverter_stop_reasons_std table
  db.exec(`
    CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inverter_ip TEXT NOT NULL,
      slave INTEGER NOT NULL,
      slot TEXT,
      timestamp_iso TEXT NOT NULL,
      motive_code INTEGER NOT NULL,
      read_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
  `);

  // Create inverter_5min_param table
  db.exec(`
    CREATE TABLE IF NOT EXISTS inverter_5min_param (
      inverter_ip TEXT NOT NULL,
      slave INTEGER NOT NULL,
      ts_ms INTEGER NOT NULL,
      iac1_a REAL,
      iac2_a REAL,
      iac3_a REAL,
      temp_c INTEGER,
      tempint_c_avg REAL
    );
  `);

  // Create ipconfig table (settings-based, but we'll mock it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Seed test data
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;

  // Node 1/1: 2 thermal trips, 1 FRAMA
  const stmtInsert = db.prepare(`
    INSERT INTO inverter_stop_reasons_std
      (inverter_ip, slave, timestamp_iso, motive_code, read_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmtInsert.run("192.168.1.101", 1, "2026-05-08T14:25:00Z", 7, oneDayAgo);         // TEMP
  stmtInsert.run("192.168.1.101", 1, "2026-04-18T11:40:00Z", 20, ninetyDaysAgo + 1000); // TEMP_AUX
  stmtInsert.run("192.168.1.101", 1, "2026-05-01T09:15:00Z", 29, oneDayAgo - 1000); // FRAMA1

  // Node 1/2: healthy (no stops)
  // (no records)

  // Seed 5-min parameter data (last hour)
  const stmtParam = db.prepare(`
    INSERT INTO inverter_5min_param
      (inverter_ip, slave, ts_ms, iac1_a, iac2_a, iac3_a, temp_c, tempint_c_avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Node 1/1: 3% imbalance, temp 68.5°C
  for (let i = 0; i < 12; i++) {
    const ts = now - (i * 5 * 60 * 1000);
    stmtParam.run("192.168.1.101", 1, ts, 120.5, 119.8, 121.2, 68.5, 67.0);
  }

  // Node 1/2: balanced, temp 64.2°C
  for (let i = 0; i < 12; i++) {
    const ts = now - (i * 5 * 60 * 1000);
    stmtParam.run("192.168.1.101", 2, ts, 110.0, 110.1, 110.0, 64.2, 63.0);
  }

  return db;
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  igbtFleetEndpoint.test.js — API Endpoints");
  console.log("──────────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────────────
  // DATABASE FIXTURE TESTS (2)
  // ─────────────────────────────────────────────────────────────────────────

  test("createTestDb: creates valid database with schema", () => {
    const db = createTestDb();

    // Check tables exist
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all();

    const tableNames = new Set(tables.map(t => t.name));
    assert.ok(tableNames.has("inverter_stop_reasons_std"));
    assert.ok(tableNames.has("inverter_5min_param"));
    assert.ok(tableNames.has("settings"));

    // Check stop-reason data
    const stopCount = db.prepare("SELECT COUNT(*) as cnt FROM inverter_stop_reasons_std").get();
    assert.strictEqual(stopCount.cnt, 3, "Should have 3 stop-reason records");

    // Check param data
    const paramCount = db.prepare("SELECT COUNT(*) as cnt FROM inverter_5min_param").get();
    assert.strictEqual(paramCount.cnt, 24, "Should have 24 param records (2 nodes × 12 slots)");

    db.close();
  });

  test("createTestDb: seeded data is queryable", () => {
    const db = createTestDb();

    // Query Node 1/1 stops
    const stops = db.prepare(`
      SELECT motive_code FROM inverter_stop_reasons_std
        WHERE inverter_ip = ? AND slave = ?
        ORDER BY read_at_ms DESC
    `).all("192.168.1.101", 1);

    assert.strictEqual(stops.length, 3);
    assert.ok(stops.some(s => s.motive_code === 7), "Should have TEMP code");
    assert.ok(stops.some(s => s.motive_code === 29), "Should have FRAMA1 code");

    // Query Node 1/2 params
    const params = db.prepare(`
      SELECT iac1_a, iac2_a, iac3_a FROM inverter_5min_param
        WHERE inverter_ip = ? AND slave = ?
    `).all("192.168.1.101", 2);

    assert.strictEqual(params.length, 12, "Should have 12 param rows");

    db.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ENDPOINT RESPONSE SHAPE TESTS — coverage lives elsewhere
  // ─────────────────────────────────────────────────────────────────────────
  //
  // The persisted-ipconfig walk that all three endpoints use is locked by
  // server/tests/ipconfigEnumerate.test.js (9 cases including a regression
  // guard for the array-shape bug that previously made every endpoint 500).
  //
  // Full HTTP-level coverage (status codes, content-type, CSV BOM, remote
  // proxy fallback) still requires booting Express; that lift is deferred to
  // Phase 2 when a shared server-test harness lands.
}

run();
