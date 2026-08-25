"use strict";

/**
 * Regression test for server/stopReasonAggregator.js — the IGBT/Contactor
 * fleet endpoints were originally blind to vendor-SCOPE auto-captures
 * (Slice F) because they only queried `inverter_stop_reasons_std`. The
 * aggregator UNIONs both `_std` and (vendor) tables with a 5-minute
 * dedup bucket on `read_at_ms` so cross-table re-reads of the same
 * physical event don't double-count.
 *
 * Runs against a temp better-sqlite3 instance so the test stays
 * self-contained.
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const {
  countMotivesCombined,
  findLastStopEvent,
  listRecentStopEvents,
  READAT_DEDUP_BUCKET_MS,
} = require("../stopReasonAggregator");

let _tmpDbSeq = 0;
function makeDb() {
  // Unique per call — Date.now() ties when two makeDb() calls fall in the
  // same ms on a fast machine, which left the previous test's WAL files
  // around and tripped sporadic smoke failures on the first cold run.
  _tmpDbSeq += 1;
  const tmpPath = path.join(
    __dirname,
    `.stop-reason-agg-${process.pid}-${Date.now()}-${_tmpDbSeq}.db`,
  );
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  try { fs.unlinkSync(`${tmpPath}-wal`); } catch (_) {}
  try { fs.unlinkSync(`${tmpPath}-shm`); } catch (_) {}
  const db = new Database(tmpPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inverter_ip TEXT NOT NULL,
      slave INTEGER NOT NULL,
      slot INTEGER,
      timestamp_iso TEXT NOT NULL,
      motive_code INTEGER NOT NULL,
      motive_name TEXT,
      read_at_ms INTEGER NOT NULL,
      captured_at_ms INTEGER,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS inverter_stop_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inverter_id INTEGER NOT NULL,
      inverter_ip TEXT NOT NULL,
      slave INTEGER NOT NULL,
      node INTEGER NOT NULL,
      read_at_ms INTEGER NOT NULL,
      event_at_ms INTEGER,
      trigger_source TEXT,
      alarm_id INTEGER,
      motparo INTEGER NOT NULL DEFAULT 0,
      motparo_label TEXT,
      raw_hex TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT ''
    );
  `);

  return { db, tmpPath };
}

const IP = "192.168.1.101";
const SLAVE = 1;

function insertStd(db, motive, readAtMs) {
  db.prepare(`
    INSERT INTO inverter_stop_reasons_std
      (inverter_ip, slave, timestamp_iso, motive_code, read_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(IP, SLAVE, new Date(readAtMs).toISOString(), motive, readAtMs);
}

function insertVendor(db, motparo, readAtMs) {
  db.prepare(`
    INSERT INTO inverter_stop_reasons
      (inverter_id, inverter_ip, slave, node, read_at_ms, motparo, raw_hex, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, IP, SLAVE, SLAVE, readAtMs, motparo, "", `fp_${motparo}_${readAtMs}`);
}

function cleanup(tmpPath) {
  try { fs.unlinkSync(tmpPath); } catch (_) {}
  try { fs.unlinkSync(`${tmpPath}-wal`); } catch (_) {}
  try { fs.unlinkSync(`${tmpPath}-shm`); } catch (_) {}
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

function run() {
  const now = Date.now();
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;

  // CASE 1: only std table has rows → count returns std count.
  test("count: std-only matches single-table baseline", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db, 7,  now - 1 * 24 * 3600_000);
      insertStd(db, 21, now - 2 * 24 * 3600_000);
      insertStd(db, 7,  now - 3 * 24 * 3600_000);
      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [7, 21]);
      assert.strictEqual(n, 3, "should count three thermal stops in std");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 2: only vendor table has rows (Slice F auto-capture only) →
  // the previous std-only query would have returned 0; the helper must
  // return the vendor count.
  test("count: vendor-only is no longer invisible", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertVendor(db, 22, now - 1 * 24 * 3600_000);
      insertVendor(db, 23, now - 2 * 24 * 3600_000);
      insertVendor(db, 22, now - 3 * 24 * 3600_000);
      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [22, 23, 24]);
      assert.strictEqual(n, 3,
        "vendor-only rows must be counted (was 0 in pre-fix std-only query)",
      );
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 3: both tables, distinct events → UNIONed count.
  test("count: distinct events across tables sum", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db, 13, now - 5 * 24 * 3600_000);
      insertVendor(db, 29, now - 6 * 24 * 3600_000);
      insertVendor(db, 30, now - 7 * 24 * 3600_000);
      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [13, 29, 30]);
      assert.strictEqual(n, 3, "should UNION 1 std + 2 vendor rows");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 4: same motive, same 5-min read_at_ms bucket in both tables →
  // dedup to one event. Manual refresh + auto-capture of the same fault.
  test("count: 5-min-bucket dedup collapses cross-table duplicates", () => {
    const { db, tmpPath } = makeDb();
    try {
      const t = now - 2 * 24 * 3600_000;
      insertStd(db, 7, t);
      insertVendor(db, 7, t + 30_000); // 30 s later, same bucket
      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [7]);
      assert.strictEqual(n, 1, "same-bucket cross-table duplicate must dedup");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 5: motive set filter must exclude unrelated codes.
  test("count: motive filter excludes other codes", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db, 7,  now - 1 * 24 * 3600_000);   // thermal
      insertStd(db, 22, now - 2 * 24 * 3600_000);   // contactor
      insertVendor(db, 26, now - 3 * 24 * 3600_000); // pi_ana
      assert.strictEqual(
        countMotivesCombined(db, IP, SLAVE, cutoff, [7, 21]), 1,
        "thermal query should only count thermal",
      );
      assert.strictEqual(
        countMotivesCombined(db, IP, SLAVE, cutoff, [22, 23, 24]), 1,
        "contactor query should only count contactor",
      );
      assert.strictEqual(
        countMotivesCombined(db, IP, SLAVE, cutoff, [26]), 1,
        "pi_ana query should only count pi_ana",
      );
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 6: cutoff filter — rows older than window must be excluded.
  test("count: cutoff filter drops events older than window", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db, 7,  now - 1 * 24 * 3600_000);     // inside 90d
      insertStd(db, 7,  now - 100 * 24 * 3600_000);   // outside 90d
      insertVendor(db, 7, now - 200 * 24 * 3600_000); // outside 90d
      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [7]);
      assert.strictEqual(n, 1, "only the in-window event should count");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 7: findLastStopEvent picks the most-recent across both tables.
  test("findLastStopEvent: most-recent across tables wins", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db,    7,  now - 5 * 24 * 3600_000);
      insertVendor(db, 13, now - 1 * 24 * 3600_000);  // newer
      const last = findLastStopEvent(db, IP, SLAVE);
      assert.ok(last, "should find at least one event");
      assert.strictEqual(last.motive_code, 13, "vendor row is most recent");
      assert.strictEqual(last.source, "vendor");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 8: findLastStopEvent honors motive filter.
  test("findLastStopEvent: motive filter selects matching last", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db,    7,  now - 5 * 24 * 3600_000);   // thermal, older
      insertVendor(db, 22, now - 1 * 24 * 3600_000);   // contactor, newer
      const lastThermal = findLastStopEvent(db, IP, SLAVE, [7, 21]);
      assert.ok(lastThermal);
      assert.strictEqual(lastThermal.motive_code, 7);
      assert.strictEqual(lastThermal.source, "std");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 9: listRecentStopEvents merges + sorts both sources.
  test("listRecentStopEvents: cross-table merge, newest first", () => {
    const { db, tmpPath } = makeDb();
    try {
      insertStd(db,    22, now - 1 * 24 * 3600_000);
      insertStd(db,    22, now - 3 * 24 * 3600_000);
      insertVendor(db, 23, now - 2 * 24 * 3600_000);
      const list = listRecentStopEvents(db, IP, SLAVE, cutoff, [22, 23, 24], 10);
      assert.strictEqual(list.length, 3);
      assert.ok(list[0].read_at_ms > list[1].read_at_ms);
      assert.ok(list[1].read_at_ms > list[2].read_at_ms);
      assert.deepStrictEqual(
        list.map((r) => r.motive_code),
        [22, 23, 22],
        "rows should be newest-first across both tables",
      );
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 10: missing tables degrade gracefully (count returns 0, last
  // returns null) — protects the IGBT endpoint from a 500 if a fresh
  // install hasn't run the relevant migrations yet.
  test("graceful degradation when one table is missing", () => {
    _tmpDbSeq += 1;
    const tmpPath = path.join(
      __dirname,
      `.aggr-missing-${process.pid}-${Date.now()}-${_tmpDbSeq}.db`,
    );
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    try { fs.unlinkSync(`${tmpPath}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${tmpPath}-shm`); } catch (_) {}
    const db = new Database(tmpPath);
    try {
      // Only the std table exists.
      db.exec(`
        CREATE TABLE inverter_stop_reasons_std (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inverter_ip TEXT NOT NULL,
          slave INTEGER NOT NULL,
          timestamp_iso TEXT NOT NULL,
          motive_code INTEGER NOT NULL,
          read_at_ms INTEGER NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO inverter_stop_reasons_std
          (inverter_ip, slave, timestamp_iso, motive_code, read_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(IP, SLAVE, "2026-05-12T00:00:00Z", 7, now - 24 * 3600_000);

      const n = countMotivesCombined(db, IP, SLAVE, cutoff, [7]);
      assert.strictEqual(n, 1, "fallback must still report std count when vendor table absent");

      const last = findLastStopEvent(db, IP, SLAVE, [7]);
      assert.ok(last, "should find the std row even without vendor table");
    } finally { db.close(); cleanup(tmpPath); }
  });

  // CASE 11: empty / invalid inputs.
  test("input guards: empty motive list / missing ip → 0 / null", () => {
    const { db, tmpPath } = makeDb();
    try {
      assert.strictEqual(countMotivesCombined(db, IP, SLAVE, cutoff, []), 0);
      assert.strictEqual(countMotivesCombined(db, "", SLAVE, cutoff, [7]), 0);
      assert.strictEqual(findLastStopEvent(db, "", SLAVE), null);
      assert.deepStrictEqual(listRecentStopEvents(db, IP, SLAVE, cutoff, []), []);
    } finally { db.close(); cleanup(tmpPath); }
  });

  // Sanity: the dedup bucket is the documented 5 minutes.
  test("constant: dedup bucket is 5 min", () => {
    assert.strictEqual(READAT_DEDUP_BUCKET_MS, 5 * 60 * 1000);
  });

  console.log("stopReasonAggregator.test.js: done");
}

run();
