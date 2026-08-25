"use strict";

// Regression test for the "insert-on-change" alarm-composition tracking
// added on 2026-05-22 (v2.11.0-beta.10), supersedes the earlier
// OR-accumulate approach that the operator rejected as "awkward and
// not right" (manufactured fictional values like 0x0250 that never
// appeared on the wire).
//
// Bug: `updateActiveAlarmValue` was UPDATEing the active row's
// alarm_value in place. An alarm that transiently added bit 4
// (e.g. 0x0040 → 0x0210 → 0x0040 → cleared) lost the bit-4 firing
// because the next poll overwrote it. 100% of 683 May-21 alarm rows
// on the live gateway showed this in-place patch behavior.
//
// Fix: every composition change CLOSES the active row (cleared_ts =
// transition timestamp) and INSERTs a NEW row with exactly the new
// observed bitmask. Each alarms row is now a faithful snapshot of
// what the inverter emitted at that moment — no merging, no
// supersets, no overwrites.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let Database;
try { Database = require("better-sqlite3"); } catch (err) {
  console.log("alarmPerCompositionRowCore.test.js: SKIP (better-sqlite3 require failed): " + err.message.split("\n")[0]);
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-per-comp-"));
const dbPath = path.join(tmpDir, "test.db");

let db;
try { db = new Database(dbPath); } catch (err) {
  console.log("alarmPerCompositionRowCore.test.js: SKIP (better-sqlite3 native binding unavailable under this Node ABI): " + err.message.split("\n")[0]);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    inverter INTEGER NOT NULL,
    unit INTEGER NOT NULL,
    alarm_code TEXT,
    alarm_value INTEGER,
    severity TEXT DEFAULT 'fault',
    cleared_ts INTEGER,
    acknowledged INTEGER DEFAULT 0,
    updated_ts INTEGER NOT NULL DEFAULT 0,
    stop_reason_id INTEGER
  );
`);

const formatAlarmHex = (v) => v ? Number(v).toString(16).toUpperCase().padStart(4, "0") + "H" : "0000H";
const ALARM_BITS_MIN = [
  { bit: 4, severity: "fault" },
  { bit: 6, severity: "fault" },
  { bit: 9, severity: "critical" },
];
const SEV_ORDER = { critical: 4, fault: 3, warning: 2, info: 1 };
const topSev = (v) => {
  let best = null;
  for (const b of ALARM_BITS_MIN) {
    if (((v >>> b.bit) & 1) === 0) continue;
    if (!best || SEV_ORDER[b.severity] > SEV_ORDER[best]) best = b.severity;
  }
  return best || "fault";
};

const insertAlarm = db.prepare(`
  INSERT INTO alarms (ts, inverter, unit, alarm_code, alarm_value, severity, updated_ts)
  VALUES (@ts, @inverter, @unit, @alarm_code, @alarm_value, @severity, @updated_ts)
`);
const clearActive = db.prepare(`
  UPDATE alarms SET cleared_ts=? WHERE inverter=? AND unit=? AND cleared_ts IS NULL
`);

// Replicated production logic under test.
function raiseActiveAlarm(row, cur, now) {
  insertAlarm.run({
    ts: now,
    inverter: row.inverter,
    unit: row.unit,
    alarm_code: formatAlarmHex(cur),
    alarm_value: cur,
    severity: topSev(cur),
    updated_ts: now,
  });
}

// Mirror of production: atomic close-and-reopen so concurrent reads
// can never observe the brief window between close and INSERT.
const _closeAndReopenAlarmTx = db.transaction((row, newCur, evTs) => {
  clearActive.run(evTs, row.inverter, row.unit);
  if (newCur === 0) return;
  raiseActiveAlarm(row, newCur, evTs);
});

function updateActiveAlarmValue(row, cur, evTs) {
  const newCur = (Number(cur) || 0) >>> 0;
  _closeAndReopenAlarmTx(row, newCur, evTs);
}

// === Test scenario: the operator's exact symptom ===
const inv = { inverter: 22, unit: 1 };
const t0 = 1779292800000;
const POLL = 3000;

try {
  // t0: alarm raises with 0x0040 (bit 6 — ADC / Sync Error)
  raiseActiveAlarm(inv, 0x0040, t0);

  // t1: alarm grows to 0x0210 (bits 4 + 9 — RMS Overcurrent + DC Protection)
  // — exactly what the operator sees on the inverter card.
  updateActiveAlarmValue(inv, 0x0210, t0 + POLL);

  // t2: alarm settles back to 0x0040.
  updateActiveAlarmValue(inv, 0x0040, t0 + 2 * POLL);

  // t3: alarm clears entirely.
  updateActiveAlarmValue(inv, 0, t0 + 3 * POLL);

  // === Verify the per-composition timeline ===
  const rows = db
    .prepare(`SELECT id, ts, alarm_value, severity, cleared_ts FROM alarms WHERE inverter=? AND unit=? ORDER BY ts ASC`)
    .all(inv.inverter, inv.unit);

  assert.equal(
    rows.length,
    3,
    `expected exactly 3 alarms rows (one per distinct composition 0x40 → 0x210 → 0x40), got ${rows.length}: ${JSON.stringify(rows.map(r => formatAlarmHex(r.alarm_value)))}`,
  );

  // Row 1: original 0x0040
  assert.equal(rows[0].alarm_value, 0x0040, "row 1 alarm_value");
  assert.equal(rows[0].ts, t0, "row 1 start ts");
  assert.equal(rows[0].cleared_ts, t0 + POLL, "row 1 must be closed at the moment 0x0210 was first observed");
  assert.equal(rows[0].severity, "fault");

  // Row 2: transient 0x0210 — this is what was being LOST before the fix
  assert.equal(
    rows[1].alarm_value,
    0x0210,
    `BUG REGRESSION: the 0x0210 transient composition must have its own row; got 0x${rows[1].alarm_value.toString(16).toUpperCase().padStart(4, "0")}`,
  );
  assert.equal(rows[1].ts, t0 + POLL, "row 2 starts at the 0x0210 transition");
  assert.equal(rows[1].cleared_ts, t0 + 2 * POLL, "row 2 closes when 0x0040 resumed");
  assert.equal(rows[1].severity, "critical", "0x0210 severity must reflect bit 9 = critical");

  // Row 3: re-emerged 0x0040
  assert.equal(rows[2].alarm_value, 0x0040, "row 3 alarm_value");
  assert.equal(rows[2].ts, t0 + 2 * POLL, "row 3 starts when 0x0040 resumed");
  assert.equal(rows[2].cleared_ts, t0 + 3 * POLL, "row 3 closes at full clear");
  assert.equal(rows[2].severity, "fault");

  // Continuity: each row's cleared_ts MUST equal the next row's ts (zero-gap timeline)
  assert.equal(rows[0].cleared_ts, rows[1].ts, "timeline gap between row 0 and row 1");
  assert.equal(rows[1].cleared_ts, rows[2].ts, "timeline gap between row 1 and row 2");

  // Sanity: no row should have alarm_value 0x0250 (the rejected OR-accumulate value)
  const hasOredValue = rows.some((r) => r.alarm_value === 0x0250);
  assert.ok(
    !hasOredValue,
    "REGRESSION: must NOT manufacture fictional supersets like 0x0250 that never appeared on the wire",
  );

  // Sanity: querying for bit 4 (`alarm_value & 0x10`) must find at least one row
  const bit4Rows = db
    .prepare(`SELECT COUNT(*) AS c FROM alarms WHERE inverter=? AND unit=? AND (alarm_value & 16) != 0`)
    .get(inv.inverter, inv.unit);
  assert.ok(
    bit4Rows.c >= 1,
    "bit 4 must be findable in the alarms table — that's the whole point of this fix",
  );

  console.log(
    "alarmPerCompositionRowCore.test.js: PASS (3 distinct rows, bit-4 transient preserved, zero-gap timeline, no fictional supersets)",
  );
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
