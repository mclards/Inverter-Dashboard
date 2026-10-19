"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
    throw err;
  }
}

const dbSrc = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const backendDbSrc = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "services", "db.js"), "utf8");
const alarmsSrc = fs.readFileSync(path.join(__dirname, "..", "alarms.js"), "utf8");
const backendAlarmsSrc = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "services", "alarms.js"), "utf8");
const appJsSrc = fs.readFileSync(path.join(__dirname, "..", "..", "public", "js", "app.js"), "utf8");
const frontendAppJsSrc = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "public", "js", "app.js"), "utf8");

test("clearAlarm statement enforces cleared_ts = MAX(ts, ?) in db.js and backend/services/db.js", () => {
  const expected = /clearAlarm:\s*db\.prepare\(\s*[`'"]UPDATE alarms SET cleared_ts = MAX\(ts, \?\) WHERE inverter=\? AND unit=\? AND cleared_ts IS NULL[`'"]\s*,?\s*\)/;
  assert.ok(expected.test(dbSrc), "server/db.js must enforce cleared_ts = MAX(ts, ?)");
  assert.ok(expected.test(backendDbSrc), "backend/services/db.js must enforce cleared_ts = MAX(ts, ?)");
});

test("startup migration repairs legacy negative-duration alarms in db.js and backend/services/db.js", () => {
  const expected = /UPDATE alarms SET cleared_ts = ts, updated_ts = \$\{NOW_MS_SQL\} WHERE cleared_ts IS NOT NULL AND cleared_ts < ts/;
  assert.ok(expected.test(dbSrc), "server/db.js must contain repairNegativeDur migration");
  assert.ok(expected.test(backendDbSrc), "backend/services/db.js must contain repairNegativeDur migration");
});

test("closeAndReopenAlarmTx clamps safeTs to prevent time regressions", () => {
  const expected = /const\s+safeTs\s*=\s*Math\.max\(Number\(existing\?\.ts\)\s*\|\|\s*0,\s*Number\(evTsNum\)\s*\|\|\s*0\);/;
  assert.ok(expected.test(alarmsSrc), "server/alarms.js must clamp safeTs");
  assert.ok(expected.test(backendAlarmsSrc), "backend/services/alarms.js must clamp safeTs");
});

test("checkAlarms closes open alarms for unconfigured nodes when pruning in-memory state", () => {
  const expected = /stmts\.clearAlarm\.run\(now,\s*inv,\s*unt\);/;
  assert.ok(expected.test(alarmsSrc), "server/alarms.js must clear alarms for unconfigured nodes");
  assert.ok(expected.test(backendAlarmsSrc), "backend/services/alarms.js must clear alarms for unconfigured nodes");
});

test("closeOrphanedUnconfiguredAlarms is defined and exported in alarms.js", () => {
  assert.ok(
    /function closeOrphanedUnconfiguredAlarms\(\)/.test(alarmsSrc),
    "server/alarms.js must define closeOrphanedUnconfiguredAlarms",
  );
  assert.ok(
    /closeOrphanedUnconfiguredAlarms/.test(alarmsSrc.match(/module\.exports\s*=\s*\{[\s\S]*?\};/)?.[0] || ""),
    "server/alarms.js must export closeOrphanedUnconfiguredAlarms",
  );
  assert.ok(
    /closeOrphanedUnconfiguredAlarms/.test(backendAlarmsSrc.match(/module\.exports\s*=\s*\{[\s\S]*?\};/)?.[0] || ""),
    "backend/services/alarms.js must export closeOrphanedUnconfiguredAlarms",
  );
});

test("duration_min helper guards against negative duration in public and frontend app.js", () => {
  const expected = /Math\.round\(Math\.max\(0,\s*ts2\s*-\s*ts1\)\s*\/\s*60000\)\s*\+\s*"m"/;
  assert.ok(expected.test(appJsSrc), "public/js/app.js duration_min must guard against negative duration");
  assert.ok(expected.test(frontendAppJsSrc), "frontend/public/js/app.js duration_min must guard against negative duration");
});

test("SQL execution test: cleared_ts cannot be set prior to ts", () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (_) {
    // Skip if binary bindings not available under current node ABI
    return;
  }
  let db;
  try {
    db = new Database(":memory:");
  } catch (_) {
    return;
  }
  db.exec(`
    CREATE TABLE alarms (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      cleared_ts INTEGER,
      inverter INTEGER NOT NULL,
      unit INTEGER NOT NULL
    );
    INSERT INTO alarms VALUES (1, 1000, NULL, 1, 1);
  `);
  const stmt = db.prepare(
    `UPDATE alarms SET cleared_ts = MAX(ts, ?) WHERE inverter=? AND unit=? AND cleared_ts IS NULL`
  );
  // Attempt to clear at timestamp 900 (100ms before start ts 1000)
  stmt.run(900, 1, 1);
  const row = db.prepare("SELECT * FROM alarms WHERE id=1").get();
  assert.strictEqual(row.cleared_ts, 1000, "cleared_ts must be clamped to start ts 1000, not 900");
  assert.ok(row.cleared_ts >= row.ts, "cleared_ts must be >= ts");
});

console.log("alarmDiscrepancyIntegrity.test.js: PASS");
