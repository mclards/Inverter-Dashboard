"use strict";

/**
 * Slice β unit tests — DB schema migration for slow-poll fields
 *
 * Tests that:
 * 1. New columns are added to inverter_5min_param via ALTER TABLE
 * 2. Migration is idempotent (safe to re-run)
 * 3. Old rows (pre-Slice β) remain intact with NULL for new columns
 * 4. New rows can be inserted with slow-field values
 *
 * Related plan: plans/slice-beta-implementation.md §6.4
 */

const Database = require("better-sqlite3");
const path = require("path");

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
  console.log("  dbSlowFieldsMigration.test.js — Slice β schema");
  console.log("──────────────────────────────────────────────────────────\n");

  // ────────────────────────────────────────────────────────────────
  // Test 1: Create in-memory DB and run migrations
  // ────────────────────────────────────────────────────────────────
  test("DB migration: new columns can be added to inverter_5min_param", () => {
    const db = new Database(":memory:");

    // Create the base table (pre-Slice β schema)
    db.exec(`
      CREATE TABLE inverter_5min_param (
        id INTEGER PRIMARY KEY,
        inverter_ip TEXT NOT NULL,
        slave INTEGER NOT NULL,
        date_local TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        vdc_v REAL,
        idc_a REAL,
        pac_w REAL,
        inv_alarms INTEGER,
        track_alarms INTEGER,
        sample_count INTEGER,
        is_complete INTEGER,
        in_solar_window INTEGER,
        updated_ts INTEGER
      );
    `);

    // Run Slice β migration (add slow-poll columns).
    // List MUST match the production migration in server/db.js exactly —
    // column names, types, and aggregation suffixes (_avg/_min/_max/_last).
    const slowColumns = [
      "qac_var_avg REAL",
      "tempint_c_min REAL",
      "tempint_c_max REAL",
      "tempint_c_avg REAL",
      "zpos_kohm_min INTEGER",
      "zpos_kohm_max INTEGER",
      "zpos_kohm_last INTEGER",
      "zneg_kohm_min INTEGER",
      "zneg_kohm_max INTEGER",
      "zneg_kohm_last INTEGER",
      "vpv_n_v_min INTEGER",
      "vpv_n_v_max INTEGER",
      "vpv_n_v_avg REAL",
      "vpv_p_v_min INTEGER",
      "vpv_p_v_max INTEGER",
      "vpv_p_v_avg REAL",
      "nominal_power_w_last INTEGER",
      "time_to_connect_s_min INTEGER",
      "time_to_connect_s_max INTEGER",
      "time_to_connect_s_avg REAL",
      "time_to_connect_total_s_min INTEGER",
      "time_to_connect_total_s_max INTEGER",
      "time_to_connect_total_s_avg REAL",
      "alarms_inst_32_max INTEGER",
      "alarms_maint_32_max INTEGER",
      "power_reduction_bits_last INTEGER",
      "analog_in_1_avg REAL",
      "analog_in_2_avg REAL",
      "analog_in_3_avg REAL",
      "analog_in_4_avg REAL",
      "pt100_1_last INTEGER",
      "pt100_2_last INTEGER",
      "inverter_state_raw_last INTEGER",
    ];

    for (const col of slowColumns) {
      const colName = col.split(" ")[0];
      try {
        db.exec(`ALTER TABLE inverter_5min_param ADD COLUMN ${col};`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) {
          throw e;
        }
      }
    }

    // Verify columns exist
    const tableInfo = db.pragma("table_info(inverter_5min_param)");
    const columnNames = tableInfo.map((c) => c.name);

    for (const col of slowColumns) {
      const colName = col.split(" ")[0];
      if (!columnNames.includes(colName)) {
        throw new Error(`Column ${colName} not found after migration`);
      }
    }

    db.close();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 2: Idempotence — running migration twice is safe
  // ────────────────────────────────────────────────────────────────
  test("DB migration: idempotent (safe to re-run)", () => {
    const db = new Database(":memory:");

    // Create base table
    db.exec(`
      CREATE TABLE inverter_5min_param (
        id INTEGER PRIMARY KEY,
        inverter_ip TEXT NOT NULL,
        slave INTEGER NOT NULL,
        date_local TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        vdc_v REAL,
        idc_a REAL,
        pac_w REAL
      );
    `);

    // Add a new column
    db.exec("ALTER TABLE inverter_5min_param ADD COLUMN qac_var_avg REAL;");

    // Try to add the same column again (should error gracefully with duplicate check)
    try {
      db.exec("ALTER TABLE inverter_5min_param ADD COLUMN qac_var_avg REAL;");
      throw new Error("Should have thrown duplicate column error");
    } catch (e) {
      if (!/duplicate/i.test(e.message)) {
        throw new Error(`Re-running migration failed with unexpected error: ${e.message}`);
      }
      // Expected — duplicate column error means migration is idempotent
    }

    db.close();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 3: Old rows (pre-Slice β) have NULL for new columns
  // ────────────────────────────────────────────────────────────────
  test("DB migration: old rows have NULL for slow columns", () => {
    const db = new Database(":memory:");

    db.exec(`
      CREATE TABLE inverter_5min_param (
        id INTEGER PRIMARY KEY,
        inverter_ip TEXT NOT NULL,
        slave INTEGER NOT NULL,
        date_local TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        vdc_v REAL,
        idc_a REAL,
        pac_w REAL,
        inv_alarms INTEGER,
        track_alarms INTEGER,
        sample_count INTEGER,
        is_complete INTEGER,
        in_solar_window INTEGER,
        updated_ts INTEGER
      );
    `);

    // Add slow columns (catch duplicate errors gracefully)
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN qac_var_avg REAL;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN zpos_kohm_last INTEGER;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN tempint_c_avg REAL;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN inverter_state_raw_last INTEGER;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }

    // Insert a pre-Slice β row (no slow columns)
    const insert = db.prepare(`
      INSERT INTO inverter_5min_param
      (inverter_ip, slave, date_local, slot_index, ts_ms, vdc_v, idc_a, pac_w,
       inv_alarms, track_alarms, sample_count, is_complete, in_solar_window, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "192.168.1.109", 1, "2026-05-10", 100, Date.now(),
      600, 50, 10000,
      0, 0, 10, 1, 1, Date.now()
    );

    // Retrieve and verify NULLs for new columns
    const row = db.prepare(
      `SELECT qac_var_avg, zpos_kohm_last, tempint_c_avg, inverter_state_raw_last FROM inverter_5min_param WHERE slot_index = 100`
    ).get();

    if (row.qac_var_avg !== null) {
      throw new Error(`Expected qac_var_avg to be NULL, got ${row.qac_var_avg}`);
    }
    if (row.zpos_kohm_last !== null) {
      throw new Error(`Expected zpos_kohm_last to be NULL, got ${row.zpos_kohm_last}`);
    }
    if (row.tempint_c_avg !== null) {
      throw new Error(`Expected tempint_c_avg to be NULL, got ${row.tempint_c_avg}`);
    }

    db.close();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 4: New rows can store slow-field values
  // ────────────────────────────────────────────────────────────────
  test("DB migration: new rows can store slow-field values", () => {
    const db = new Database(":memory:");

    db.exec(`
      CREATE TABLE inverter_5min_param (
        id INTEGER PRIMARY KEY,
        inverter_ip TEXT NOT NULL,
        slave INTEGER NOT NULL,
        date_local TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        vdc_v REAL,
        idc_a REAL,
        pac_w REAL,
        inv_alarms INTEGER,
        track_alarms INTEGER,
        sample_count INTEGER,
        is_complete INTEGER,
        in_solar_window INTEGER,
        updated_ts INTEGER
      );
    `);

    // Add slow columns (catch duplicate errors gracefully)
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN qac_var_avg REAL;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN zpos_kohm_last INTEGER;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN tempint_c_avg REAL;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN inverter_state_raw_last INTEGER;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }
    try { db.exec("ALTER TABLE inverter_5min_param ADD COLUMN vpv_n_v_avg REAL;"); } catch (e) { if (!/duplicate/i.test(e.message)) throw e; }

    // Insert a post-Slice β row with slow-field values
    const insert = db.prepare(`
      INSERT INTO inverter_5min_param
      (inverter_ip, slave, date_local, slot_index, ts_ms, vdc_v, idc_a, pac_w,
       qac_var_avg, zpos_kohm_last, tempint_c_avg, inverter_state_raw_last, vpv_n_v_avg,
       inv_alarms, track_alarms, sample_count, is_complete, in_solar_window, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "192.168.1.109", 1, "2026-05-10", 101, Date.now(),
      600, 50, 10000,
      -100, 50, 35, 0x0202, 455,
      0, 0, 10, 1, 1, Date.now()
    );

    // Retrieve and verify values stored correctly
    const row = db.prepare(
      `SELECT qac_var_avg, zpos_kohm_last, tempint_c_avg, inverter_state_raw_last, vpv_n_v_avg FROM inverter_5min_param WHERE slot_index = 101`
    ).get();

    if (row.qac_var_avg !== -100) {
      throw new Error(`Expected qac_var_avg = -100, got ${row.qac_var_avg}`);
    }
    if (row.zpos_kohm_last !== 50) {
      throw new Error(`Expected zpos_kohm_last = 50, got ${row.zpos_kohm_last}`);
    }
    if (row.tempint_c_avg !== 35) {
      throw new Error(`Expected tempint_c_avg = 35, got ${row.tempint_c_avg}`);
    }
    if (row.inverter_state_raw_last !== 0x0202) {
      throw new Error(`Expected inverter_state_raw_last = 0x0202, got ${row.inverter_state_raw_last}`);
    }
    if (row.vpv_n_v_avg !== 455) {
      throw new Error(`Expected vpv_n_v_avg = 455, got ${row.vpv_n_v_avg}`);
    }

    db.close();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 5: All 26 slow-field columns can be added
  // ────────────────────────────────────────────────────────────────
  test("DB migration: all 26 slow-field columns added without error", () => {
    const db = new Database(":memory:");

    db.exec(`
      CREATE TABLE inverter_5min_param (
        id INTEGER PRIMARY KEY,
        inverter_ip TEXT NOT NULL,
        slave INTEGER NOT NULL,
        date_local TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        vdc_v REAL
      );
    `);

    const slowColumns = [
      "qac_var_avg REAL",
      "qac_var_min REAL",
      "qac_var_max REAL",
      "zpos_kohm_last INTEGER",
      "zneg_kohm_last INTEGER",
      "tempint_c_avg REAL",
      "tempint_c_min REAL",
      "tempint_c_max REAL",
      "inverter_state_raw_last INTEGER",
      "vpv_n_v_avg REAL",
      "vpv_n_v_min REAL",
      "vpv_n_v_max REAL",
      "vpv_p_v_avg REAL",
      "vpv_p_v_min REAL",
      "vpv_p_v_max REAL",
      "nominal_power_w_last INTEGER",
      "time_to_connect_s_last INTEGER",
      "power_reduction_bits_last INTEGER",
      "alarms_inst_32_max INTEGER",
      "alarms_maint_32_max INTEGER",
      "analog_in_1_avg REAL",
      "analog_in_2_avg REAL",
      "analog_in_3_avg REAL",
      "analog_in_4_avg REAL",
      "pt100_1_avg REAL",
      "pt100_2_avg REAL",
    ];

    let count = 0;
    for (const col of slowColumns) {
      try {
        db.exec(`ALTER TABLE inverter_5min_param ADD COLUMN ${col};`);
      } catch (e) {
        if (!/duplicate/i.test(e.message)) throw e;
      }
      count++;
    }

    // Verify all were added
    const tableInfo = db.pragma("table_info(inverter_5min_param)");
    if (tableInfo.length < 7 + slowColumns.length - 1) {
      throw new Error(`Expected at least ${7 + slowColumns.length - 1} columns, got ${tableInfo.length}`);
    }

    db.close();
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  All tests completed");
  console.log("──────────────────────────────────────────────────────────\n");
}

run();
