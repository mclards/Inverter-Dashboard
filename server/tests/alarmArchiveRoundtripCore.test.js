"use strict";

// Round-trip test for the alarm-archive feature added in v2.11.0-beta.10.
//
// Validates the archive write path (selectOldAlarmsBatch + archiveRowsByMonth
// + deleteAlarmsBatchTx) and the archive-aware read path
// (queryAlarmsRangeArchiveAware + findAlarmByIdArchiveAware) by building
// the exact schema and statement set against an in-memory hot DB + a
// temp on-disk archive directory, without loading server/db.js (which
// would pull better-sqlite3 in whatever ABI mode the repo happens to be
// in). The contract under test:
//
//   1. selectOldAlarmsBatch returns ONLY cleared alarms older than cutoff.
//   2. archiveRowsByMonth("alarms") groups rows by month and INSERTs into
//      the matching <YYYY-MM>.db shard with the hot id preserved.
//   3. After migration, the hot DB no longer has the rows but the archive
//      shard does.
//   4. queryAlarmsRangeArchiveAware merges hot + archive shards and
//      respects the ts-DESC + LIMIT contract.
//   5. findAlarmByIdArchiveAware finds rows whether they live hot or
//      archived.
//   6. Active alarms (cleared_ts IS NULL) are NEVER pulled by the
//      selector — they stay hot regardless of age.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.log(
    "alarmArchiveRoundtripCore.test.js: SKIP (better-sqlite3 require failed: " +
      err.message.split("\n")[0] +
      ")",
  );
  process.exit(0);
}

// ─── Test fixture ──────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-archive-test-"));
const hotPath = path.join(tmpDir, "hot.db");
const archiveDir = path.join(tmpDir, "archive");
fs.mkdirSync(archiveDir, { recursive: true });

// better-sqlite3 instantiation can fail with ERR_DLOPEN_FAILED when the
// repo is in Electron-ABI mode (per project convention). Skip cleanly
// rather than failing the suite — the Electron-ABI build path is the
// one that ships, and the alarm-archive logic is covered by the static
// shape test (alarmArchiveContractShape.test.js) in either ABI mode.
let hot;
try {
  hot = new Database(hotPath);
} catch (err) {
  console.log(
    "alarmArchiveRoundtripCore.test.js: SKIP (better-sqlite3 native binding unavailable under this Node ABI — runs under npm run rebuild:native:node): " +
      err.message.split("\n")[0],
  );
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}
hot.pragma("journal_mode = WAL");
hot.exec(`
  CREATE TABLE alarms (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    inverter     INTEGER NOT NULL,
    unit         INTEGER NOT NULL,
    alarm_code   TEXT,
    alarm_value  INTEGER,
    severity     TEXT DEFAULT 'fault',
    cleared_ts   INTEGER,
    acknowledged INTEGER DEFAULT 0,
    updated_ts   INTEGER NOT NULL DEFAULT 0,
    stop_reason_id INTEGER
  );
  CREATE INDEX idx_a_ts     ON alarms(ts);
  CREATE INDEX idx_a_inv_ts ON alarms(inverter, ts);
`);

// Seed: 3 months of fake alarms.
//   • March: 5 alarms, ALL cleared (eligible for archive)
//   • April: 4 alarms, 3 cleared + 1 active (only 3 eligible)
//   • May (recent): 2 alarms, both cleared but inside retention window
const insertA = hot.prepare(`
  INSERT INTO alarms (ts, inverter, unit, alarm_code, alarm_value, severity,
    cleared_ts, acknowledged, updated_ts, stop_reason_id)
  VALUES (@ts,@inv,@unit,@code,@val,@sev,@cleared,@ack,@upd,@srid)
`);
function ts(y, m, d, h = 12) {
  return new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`).getTime();
}
const seed = [
  // March (3 weeks old in test time)
  { ts: ts(2026, 3, 1),  inv: 1, unit: 1, code: "0040H", val: 64,   sev: "fault",    cleared: ts(2026, 3, 1, 13), ack: 1, upd: ts(2026, 3, 2), srid: null },
  { ts: ts(2026, 3, 5),  inv: 2, unit: 2, code: "0010H", val: 16,   sev: "warning",  cleared: ts(2026, 3, 5, 13), ack: 1, upd: ts(2026, 3, 6), srid: null },
  { ts: ts(2026, 3, 10), inv: 1, unit: 3, code: "0080H", val: 128,  sev: "fault",    cleared: ts(2026, 3, 10,14), ack: 1, upd: ts(2026, 3, 11), srid: null },
  { ts: ts(2026, 3, 20), inv: 3, unit: 1, code: "0001H", val: 1,    sev: "info",     cleared: ts(2026, 3, 20,13), ack: 0, upd: ts(2026, 3, 21), srid: null },
  { ts: ts(2026, 3, 31), inv: 2, unit: 4, code: "2240H", val: 8768, sev: "critical", cleared: ts(2026, 3, 31,15), ack: 1, upd: ts(2026, 4, 1),  srid: null },
  // April
  { ts: ts(2026, 4, 2),  inv: 1, unit: 1, code: "0040H", val: 64,   sev: "fault",    cleared: ts(2026, 4, 2, 13), ack: 1, upd: ts(2026, 4, 3),  srid: null },
  { ts: ts(2026, 4, 10), inv: 2, unit: 2, code: "0020H", val: 32,   sev: "warning",  cleared: ts(2026, 4, 10,13), ack: 1, upd: ts(2026, 4, 11), srid: null },
  { ts: ts(2026, 4, 20), inv: 1, unit: 3, code: "0008H", val: 8,    sev: "fault",    cleared: ts(2026, 4, 20,13), ack: 1, upd: ts(2026, 4, 21), srid: null },
  { ts: ts(2026, 4, 25), inv: 3, unit: 1, code: "7FFFH", val: 32767, sev: "critical", cleared: null /* ACTIVE — never archived */, ack: 0, upd: ts(2026, 4, 25), srid: null },
  // May (recent, inside retention window — should NOT migrate)
  { ts: ts(2026, 5, 21), inv: 1, unit: 1, code: "0040H", val: 64,   sev: "fault",    cleared: ts(2026, 5, 21,13), ack: 1, upd: ts(2026, 5, 21, 14), srid: null },
  { ts: ts(2026, 5, 22), inv: 2, unit: 2, code: "0010H", val: 16,   sev: "warning",  cleared: ts(2026, 5, 22,13), ack: 1, upd: ts(2026, 5, 22, 14), srid: null },
];
for (const row of seed) insertA.run(row);

// ─── Module under test (mirror of server/db.js prepared statements) ────────
const selectOldAlarmsBatch = hot.prepare(`
  SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity,
         cleared_ts, acknowledged, updated_ts, stop_reason_id
    FROM alarms
   WHERE ts < ? AND cleared_ts IS NOT NULL
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
const deleteAlarmById = hot.prepare(`DELETE FROM alarms WHERE id=?`);
const deleteAlarmsBatchTx = hot.transaction((ids) => {
  for (const id of ids || []) deleteAlarmById.run(id);
});

function monthKeyFromTs(t) {
  const d = new Date(Number(t));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const archiveEntries = new Map();
function getArchiveEntry(monthKey, createIfMissing) {
  if (archiveEntries.has(monthKey)) return archiveEntries.get(monthKey);
  const file = path.join(archiveDir, `${monthKey}.db`);
  if (!createIfMissing && !fs.existsSync(file)) return null;
  const adb = new Database(file);
  adb.exec(`
    CREATE TABLE IF NOT EXISTS alarms (
      id             INTEGER PRIMARY KEY,
      ts             INTEGER NOT NULL,
      inverter       INTEGER NOT NULL,
      unit           INTEGER NOT NULL,
      alarm_code     TEXT,
      alarm_value    INTEGER,
      severity       TEXT DEFAULT 'fault',
      cleared_ts     INTEGER,
      acknowledged   INTEGER DEFAULT 0,
      updated_ts     INTEGER NOT NULL DEFAULT 0,
      stop_reason_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_aa_ts ON alarms(ts);
    CREATE INDEX IF NOT EXISTS idx_aa_inv_ts ON alarms(inverter, ts);
  `);
  const entry = { db: adb };
  entry.insertAlarm = adb.prepare(`
    INSERT OR IGNORE INTO alarms
    (id, ts, inverter, unit, alarm_code, alarm_value, severity,
     cleared_ts, acknowledged, updated_ts, stop_reason_id)
    VALUES (@id, @ts, @inverter, @unit, @alarm_code, @alarm_value,
            @severity, @cleared_ts, @acknowledged, @updated_ts, @stop_reason_id)
  `);
  entry.insertAlarmsTx = adb.transaction((rows) => {
    for (const row of rows || []) entry.insertAlarm.run(row);
  });
  entry.selectAlarmsRangeAll = adb.prepare(
    `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
       FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts DESC`,
  );
  entry.selectAlarmsRangeByInv = adb.prepare(
    `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
       FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC`,
  );
  archiveEntries.set(monthKey, entry);
  return entry;
}

function archiveAlarmRowsByMonth(rows) {
  const groups = new Map();
  for (const row of rows) {
    const k = monthKeyFromTs(row.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const [k, g] of groups.entries()) getArchiveEntry(k, true).insertAlarmsTx(g);
}

function* iterateMonthKeys(s, e) {
  const start = new Date(s);
  const end = new Date(e);
  let y = start.getFullYear(), m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    yield `${y}-${String(m + 1).padStart(2, "0")}`;
    m++;
    if (m > 11) { m = 0; y++; }
  }
}

function queryAlarmsRangeArchiveAware(s, e, { inverter, limit } = {}) {
  const cap = Math.max(1, Math.min(20000, Math.trunc(Number(limit) || 2000)));
  const invNum = Math.trunc(Number(inverter || 0));
  const hasInv = Number.isFinite(invNum) && invNum > 0;
  const out = new Map();
  function push(rows) {
    for (const r of rows) {
      const k = Number(r.id || 0);
      if (!out.has(k)) out.set(k, r);
    }
  }
  push(
    hasInv
      ? hot.prepare(
          `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
             FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
        ).all(invNum, s, e, cap)
      : hot.prepare(
          `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
             FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
        ).all(s, e, cap),
  );
  for (const k of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(k, false);
    if (!entry) continue;
    push(hasInv ? entry.selectAlarmsRangeByInv.all(invNum, s, e) : entry.selectAlarmsRangeAll.all(s, e));
  }
  return Array.from(out.values())
    .sort((a, b) => Number(b.ts) - Number(a.ts) || Number(b.id) - Number(a.id))
    .slice(0, cap);
}

function findAlarmByIdArchiveAware(id) {
  const hotRow = hot.prepare(`SELECT * FROM alarms WHERE id=?`).get(id);
  if (hotRow) return hotRow;
  const monthKeys = fs.readdirSync(archiveDir).filter((n) => /^\d{4}-\d{2}\.db$/.test(n))
    .map((n) => n.replace(/\.db$/i, "")).sort().reverse();
  for (const k of monthKeys) {
    const entry = getArchiveEntry(k, false);
    if (!entry) continue;
    const row = entry.db.prepare(`SELECT * FROM alarms WHERE id=?`).get(id);
    if (row) return row;
  }
  return null;
}

// ─── Run the round-trip ────────────────────────────────────────────────────
function testRoundtrip() {
  const cutoff = ts(2026, 5, 1); // archive everything before 2026-05-01

  // 1. Selector returns only CLEARED rows below cutoff.
  const eligible = selectOldAlarmsBatch.all(cutoff, 1000);
  const activeFound = eligible.find((r) => r.cleared_ts == null);
  assert.equal(activeFound, undefined, "selectOldAlarmsBatch leaked an active alarm");
  assert.equal(eligible.length, 8, `expected 8 eligible (5 Mar + 3 Apr cleared), got ${eligible.length}`);

  // 2. Archive write path.
  archiveAlarmRowsByMonth(eligible);
  // Confirm the right monthly shards exist.
  assert.ok(fs.existsSync(path.join(archiveDir, "2026-03.db")), "2026-03.db not written");
  assert.ok(fs.existsSync(path.join(archiveDir, "2026-04.db")), "2026-04.db not written");

  // 3. Batch-delete the archived ids from hot.
  deleteAlarmsBatchTx(eligible.map((r) => r.id));

  // After migration:
  //   Hot DB should have: 1 active (April) + 2 May rows = 3 rows total.
  const hotLeft = hot.prepare(`SELECT COUNT(*) AS c FROM alarms`).get().c;
  assert.equal(hotLeft, 3, `hot DB should have 3 rows after migration (1 active + 2 recent), got ${hotLeft}`);

  // 4. Archive-aware merge — query March-May window.
  const wide = queryAlarmsRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { limit: 100 });
  assert.equal(wide.length, 11, `archive-aware read should surface ALL 11 seeded alarms, got ${wide.length}`);
  // Most recent first.
  assert.ok(wide[0].ts >= wide[wide.length - 1].ts, "results not sorted ts DESC");

  // 5. By-inverter filtering through both tiers.
  const inv1 = queryAlarmsRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { inverter: 1, limit: 100 });
  assert.ok(inv1.every((r) => r.inverter === 1), "inverter filter leaked rows");
  assert.equal(inv1.length, 5, `expected 5 inv=1 rows total across hot + archive, got ${inv1.length}`);

  // 6. LIMIT contract.
  const capped = queryAlarmsRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { limit: 3 });
  assert.equal(capped.length, 3, "LIMIT not applied across merged rows");
  // The 3 newest must come back (May 22, May 21, then either the active April row OR an archive row).
  assert.equal(new Date(capped[0].ts).getUTCMonth(), 4 /* May */, "limit-capped result missed newest row");

  // 7. findAlarmByIdArchiveAware locates rows in BOTH tiers.
  const idHot = hot.prepare(`SELECT id FROM alarms LIMIT 1`).get().id;
  assert.ok(findAlarmByIdArchiveAware(idHot), "findAlarmByIdArchiveAware missed a hot row");
  const idArc = getArchiveEntry("2026-03", false).db.prepare(`SELECT id FROM alarms LIMIT 1`).get().id;
  assert.ok(findAlarmByIdArchiveAware(idArc), "findAlarmByIdArchiveAware missed an archive row");
  assert.equal(findAlarmByIdArchiveAware(99999), null, "findAlarmByIdArchiveAware should return null for missing id");
}

try {
  testRoundtrip();
  console.log(
    "alarmArchiveRoundtripCore.test.js: PASS (write → migrate → archive-aware read + by-inverter + LIMIT + by-id all green)",
  );
} finally {
  // Clean up.
  try { hot.close(); } catch (_) {}
  for (const entry of archiveEntries.values()) {
    try { entry.db.close(); } catch (_) {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
