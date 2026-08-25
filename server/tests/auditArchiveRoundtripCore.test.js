"use strict";

// Round-trip test for the audit_log archive feature added in v2.11.1.
//
// Mirrors alarmArchiveRoundtripCore.test.js exactly — same skip pattern
// when better-sqlite3 native binding can't load under the current Node ABI,
// same hot+archive temp-DB fixture, same write → migrate → read flow.
//
// Contract under test:
//   1. selectOldAuditBatch returns rows older than cutoff (no cleared_ts
//      equivalent — audit rows are immutable, so every old row is eligible).
//   2. archiveRowsByMonth("audit") groups rows by month and INSERTs into
//      the matching <YYYY-MM>.db shard with the hot id preserved.
//   3. After migration, the hot DB no longer has the old rows but each
//      monthly archive shard does.
//   4. queryAuditRangeArchiveAware merges hot + archive shards and respects
//      the ts-DESC + LIMIT contract.
//   5. inverter filter works through both tiers.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.log(
    "auditArchiveRoundtripCore.test.js: SKIP (better-sqlite3 require failed: " +
      err.message.split("\n")[0] +
      ")",
  );
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-archive-test-"));
const hotPath = path.join(tmpDir, "hot.db");
const archiveDir = path.join(tmpDir, "archive");
fs.mkdirSync(archiveDir, { recursive: true });

let hot;
try {
  hot = new Database(hotPath);
} catch (err) {
  console.log(
    "auditArchiveRoundtripCore.test.js: SKIP (better-sqlite3 native binding unavailable under this Node ABI — runs under npm run rebuild:native:node): " +
      err.message.split("\n")[0],
  );
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}
hot.pragma("journal_mode = WAL");
hot.exec(`
  CREATE TABLE audit_log (
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
  CREATE INDEX idx_audit_ts     ON audit_log(ts);
  CREATE INDEX idx_audit_inv_ts ON audit_log(inverter, ts);
`);

const insertA = hot.prepare(`
  INSERT INTO audit_log (ts, operator, inverter, node, action, scope, result, ip, reason)
  VALUES (@ts,@operator,@inverter,@node,@action,@scope,@result,@ip,@reason)
`);

function ts(y, m, d, h = 12) {
  return new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`,
  ).getTime();
}

// Seed: 3 months of operator + system events.
const seed = [
  // March (older than cutoff)
  { ts: ts(2026, 3, 1),  operator: "admin",    inverter: 1, node: 1, action: "start_node", scope: "single", result: "ok",  ip: "10.0.0.5", reason: "" },
  { ts: ts(2026, 3, 5),  operator: "admin",    inverter: 2, node: 0, action: "stop_all",   scope: "all",    result: "ok",  ip: "10.0.0.5", reason: "" },
  { ts: ts(2026, 3, 10), operator: "SYSTEM",   inverter: 0, node: 0, action: "plant_cap",  scope: "global", result: "ok",  ip: "",         reason: "Plant cap to 80%" },
  { ts: ts(2026, 3, 20), operator: "operator", inverter: 3, node: 2, action: "start_node", scope: "single", result: "ok",  ip: "10.0.0.7", reason: "" },
  { ts: ts(2026, 3, 31), operator: "SYSTEM",   inverter: 0, node: 0, action: "auto_block", scope: "global", result: "ok",  ip: "",         reason: "Critical pattern 0x0240" },
  // April (older than cutoff)
  { ts: ts(2026, 4, 2),  operator: "admin",    inverter: 1, node: 1, action: "stop_node",  scope: "single", result: "ok",  ip: "10.0.0.5", reason: "Maintenance" },
  { ts: ts(2026, 4, 10), operator: "SYSTEM",   inverter: 0, node: 0, action: "calib_save", scope: "global", result: "ok",  ip: "",         reason: "" },
  { ts: ts(2026, 4, 20), operator: "operator", inverter: 1, node: 3, action: "start_node", scope: "single", result: "ok",  ip: "10.0.0.7", reason: "" },
  { ts: ts(2026, 4, 25), operator: "admin",    inverter: 3, node: 1, action: "ack_block",  scope: "single", result: "ok",  ip: "10.0.0.5", reason: "" },
  // May (recent — inside retention window, should NOT migrate)
  { ts: ts(2026, 5, 21), operator: "admin",    inverter: 1, node: 1, action: "stop_node",  scope: "single", result: "ok",  ip: "10.0.0.5", reason: "" },
  { ts: ts(2026, 5, 22), operator: "operator", inverter: 2, node: 2, action: "start_node", scope: "single", result: "ok",  ip: "10.0.0.7", reason: "" },
];
for (const row of seed) insertA.run(row);

// ─── Module under test (mirror of server/db.js prepared statements) ────────
const selectOldAuditBatch = hot.prepare(`
  SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
    FROM audit_log
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
const deleteAuditById = hot.prepare(`DELETE FROM audit_log WHERE id=?`);
const deleteAuditBatchTx = hot.transaction((ids) => {
  for (const id of ids || []) deleteAuditById.run(id);
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
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS idx_aau_ts     ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_aau_inv_ts ON audit_log(inverter, ts);
  `);
  const entry = { db: adb };
  entry.insertAudit = adb.prepare(`
    INSERT OR IGNORE INTO audit_log
    (id, ts, operator, inverter, node, action, scope, result, ip, reason)
    VALUES (@id, @ts, @operator, @inverter, @node, @action, @scope,
            @result, @ip, @reason)
  `);
  entry.insertAuditTx = adb.transaction((rows) => {
    for (const row of rows || []) entry.insertAudit.run(row);
  });
  entry.selectAuditRangeAll = adb.prepare(
    `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
       FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY ts DESC`,
  );
  entry.selectAuditRangeByInv = adb.prepare(
    `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
       FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC`,
  );
  archiveEntries.set(monthKey, entry);
  return entry;
}

function archiveAuditRowsByMonth(rows) {
  const groups = new Map();
  for (const row of rows) {
    const k = monthKeyFromTs(row.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const [k, g] of groups.entries()) getArchiveEntry(k, true).insertAuditTx(g);
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

function queryAuditRangeArchiveAware(s, e, { inverter, limit } = {}) {
  const cap = Math.max(1, Math.min(20000, Math.trunc(Number(limit) || 5000)));
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
          `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
             FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
        ).all(invNum, s, e, cap)
      : hot.prepare(
          `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
             FROM audit_log WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ?`,
        ).all(s, e, cap),
  );
  for (const k of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(k, false);
    if (!entry) continue;
    push(hasInv ? entry.selectAuditRangeByInv.all(invNum, s, e) : entry.selectAuditRangeAll.all(s, e));
  }
  return Array.from(out.values())
    .sort((a, b) => Number(b.ts) - Number(a.ts) || Number(b.id) - Number(a.id))
    .slice(0, cap);
}

// ─── Run the round-trip ────────────────────────────────────────────────────
function testRoundtrip() {
  const cutoff = ts(2026, 5, 1); // archive everything before 2026-05-01

  // 1. Selector returns rows older than cutoff.
  const eligible = selectOldAuditBatch.all(cutoff, 1000);
  assert.equal(eligible.length, 9, `expected 9 eligible (5 Mar + 4 Apr), got ${eligible.length}`);
  assert.ok(eligible.every((r) => r.ts < cutoff), "selector leaked a recent (above-cutoff) row");

  // 2. Archive write path — month grouping + INSERT OR IGNORE.
  archiveAuditRowsByMonth(eligible);
  assert.ok(fs.existsSync(path.join(archiveDir, "2026-03.db")), "2026-03.db not written");
  assert.ok(fs.existsSync(path.join(archiveDir, "2026-04.db")), "2026-04.db not written");

  // 3. Batch-delete the archived ids from hot.
  deleteAuditBatchTx(eligible.map((r) => r.id));
  const hotLeft = hot.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get().c;
  assert.equal(hotLeft, 2, `hot DB should retain 2 recent rows after migration, got ${hotLeft}`);

  // 4. Archive-aware merge across the full March–May window.
  const wide = queryAuditRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { limit: 100 });
  assert.equal(wide.length, 11, `archive-aware read must surface all 11 seeded rows (hot + archive), got ${wide.length}`);
  // Newest first.
  for (let i = 1; i < wide.length; i++) {
    assert.ok(wide[i - 1].ts >= wide[i].ts, "results must sort ts DESC across the merged set");
  }

  // 5. By-inverter filter works through both tiers.
  const inv1 = queryAuditRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { inverter: 1, limit: 100 });
  assert.ok(inv1.every((r) => r.inverter === 1), "inverter filter leaked rows from other inverters");
  // Seeded inv=1 rows: Mar 1, Apr 2, Apr 20, May 21 = 4 rows.
  assert.equal(inv1.length, 4, `expected 4 inv=1 rows total across hot + archive, got ${inv1.length}`);

  // 6. LIMIT contract — cap applied AFTER merge so old + new co-exist.
  const capped = queryAuditRangeArchiveAware(ts(2026, 3, 1), ts(2026, 5, 23), { limit: 3 });
  assert.equal(capped.length, 3, "LIMIT not applied across merged rows");
  // Newest must come back first (May 22).
  assert.equal(new Date(capped[0].ts).getUTCMonth(), 4 /* May */, "limit-capped result missed newest row");

  // 7. Reason + operator survive the migration (TEXT columns intact).
  const sysRow = wide.find((r) => r.operator === "SYSTEM" && r.action === "auto_block");
  assert.ok(sysRow, "SYSTEM auto_block row not surfaced from archive");
  assert.equal(sysRow.reason, "Critical pattern 0x0240", "reason TEXT lost across migration");
}

try {
  testRoundtrip();
  console.log(
    "auditArchiveRoundtripCore.test.js: PASS (selector + archive-write + delete + archive-aware-read + by-inverter + LIMIT all green)",
  );
} finally {
  try { hot.close(); } catch (_) {}
  for (const entry of archiveEntries.values()) {
    try { entry.db.close(); } catch (_) {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
