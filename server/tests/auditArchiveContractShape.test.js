"use strict";

// ABI-agnostic shape test for the audit_log archive contract added in
// v2.11.1. Parses server/db.js + server/alarms.js + server/index.js as text
// (no better-sqlite3 load), locking the wiring that prevents the same
// retention-deletes-data class of bug from recurring for the operator's
// control-action audit log — the v2.11.0-beta.10 alarms fix in source-of-
// truth form, applied to audit_log.
//
// Companion to auditArchiveRoundtripCore.test.js which exercises the
// write/migrate/read flow under Node-ABI.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dbSrc     = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const alarmsSrc = fs.readFileSync(path.join(__dirname, "..", "alarms.js"), "utf8");
const indexSrc  = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

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

// ─── Schema ────────────────────────────────────────────────────────────────
test("archive schema declares an audit_log table DDL", () => {
  assert.ok(
    /const ARCHIVE_AUDIT_TABLE_DDL\s*=\s*`[\s\S]*id\s+INTEGER PRIMARY KEY/.test(dbSrc),
    "ARCHIVE_AUDIT_TABLE_DDL must exist with `id INTEGER PRIMARY KEY` (no AUTOINCREMENT so hot ids migrate intact)",
  );
  assert.ok(
    /AUTOINCREMENT/.test(
      dbSrc.match(/const ARCHIVE_AUDIT_TABLE_DDL[\s\S]*?`;/)[0],
    ) === false,
    "archive audit_log table MUST NOT use AUTOINCREMENT — hot id must be preserved so dedup by id is stable across tiers",
  );
});

test("ensureArchiveSchema creates audit_log table on every shard", () => {
  const block = dbSrc.match(/function ensureArchiveSchema[\s\S]*?\n\}/)[0];
  assert.ok(
    /CREATE TABLE IF NOT EXISTS audit_log/.test(block),
    "ensureArchiveSchema must CREATE TABLE IF NOT EXISTS audit_log so pre-existing archive shards gain it on reopen",
  );
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_aau_ts/.test(block) &&
      /CREATE INDEX IF NOT EXISTS idx_aau_inv_ts/.test(block),
    "ensureArchiveSchema must create idx_aau_ts AND idx_aau_inv_ts on the archive audit_log table",
  );
});

test("archive entry exposes audit insert + range statements", () => {
  const block = dbSrc.match(/function createArchiveEntry[\s\S]*?return entry;\n\}/)[0];
  for (const stmt of [
    "insertAudit",
    "selectAuditRangeAll",
    "selectAuditRangeByInv",
    "insertAuditTx",
  ]) {
    assert.ok(
      new RegExp(`(entry\\.)?${stmt}`).test(block),
      `createArchiveEntry must expose ${stmt}`,
    );
  }
  assert.ok(
    /INSERT OR IGNORE INTO audit_log/.test(block),
    "archive audit_log insert must use INSERT OR IGNORE so re-runs are idempotent",
  );
});

// ─── Write path ────────────────────────────────────────────────────────────
test("pruner now ARCHIVES audit_log instead of permanently deleting it", () => {
  // The pre-v2.11.1 bug: pruneOldData ran
  //   db.prepare("DELETE FROM audit_log WHERE ts < ?").run(auditCutoff);
  // unconditionally. That MUST NOT exist anymore — it's the same data-loss
  // pattern the v2.11.0-beta.10 alarms fix eliminated.
  const pruneBlock = dbSrc.match(/async function pruneOldData[\s\S]*?\n\}\s*\n/)[0];
  assert.ok(
    !/db\.prepare\(\s*["']DELETE FROM audit_log[^)]*\)\.run\(auditCutoff\)/.test(pruneBlock),
    "REGRESSION: pruneOldData() still contains the unconditional `DELETE FROM audit_log ... run(auditCutoff)` — same vulnerability that caused the 2026-05-22 alarms incident. archiveAuditBeforeCutoff(auditCutoff) must own the migration.",
  );

  // The new selector + dedicated archive function must be present.
  assert.ok(
    /selectOldAuditBatch\s*=\s*db\.prepare\(/.test(dbSrc),
    "selectOldAuditBatch prepared statement missing — archive selector must exist",
  );
  // Audit rows are immutable: every row older than cutoff is eligible (no
  // cleared_ts filter like alarms have).
  const selBlock = dbSrc.match(/selectOldAuditBatch\s*=\s*db\.prepare\(`[\s\S]*?`\)/)[0];
  assert.ok(
    /FROM audit_log\s+WHERE ts < \?/.test(selBlock),
    "selectOldAuditBatch must filter `ts < ?` (audit rows are immutable; no cleared_ts equivalent)",
  );

  // The archive worker function exists.
  assert.ok(
    /async function archiveAuditBeforeCutoff/.test(dbSrc),
    "archiveAuditBeforeCutoff worker function must exist",
  );
  const auditArchBlock = dbSrc.match(/async function archiveAuditBeforeCutoff[\s\S]*?\n\}/)[0];
  assert.ok(
    /selectOldAuditBatch\.all\(cutoff, ARCHIVE_BATCH_SIZE\)/.test(auditArchBlock),
    "archiveAuditBeforeCutoff must drain selectOldAuditBatch in batches",
  );
  assert.ok(
    /archiveRowsByMonth\(rows,\s*["']audit["']\)/.test(auditArchBlock),
    "archiveAuditBeforeCutoff must call archiveRowsByMonth(rows, 'audit')",
  );
  assert.ok(
    /deleteAuditBatchTx/.test(auditArchBlock),
    "archiveAuditBeforeCutoff must delete archived rows from hot via deleteAuditBatchTx",
  );

  // pruneOldData must now invoke archiveAuditBeforeCutoff with auditCutoff.
  assert.ok(
    /archiveAuditBeforeCutoff\(auditCutoff\)/.test(pruneBlock),
    "pruneOldData must call archiveAuditBeforeCutoff(auditCutoff) — replaces the deleted DELETE",
  );
});

test("archiveRowsByMonth dispatches the audit type", () => {
  const block = dbSrc.match(/function archiveRowsByMonth[\s\S]*?\n\}/)[0];
  assert.ok(
    /type === ["']audit["'][\s\S]*insertAuditTx/.test(block),
    "archiveRowsByMonth must route type='audit' to entry.insertAuditTx",
  );
});

// ─── Read path ─────────────────────────────────────────────────────────────
test("queryAuditRangeArchiveAware merges hot + archive shards", () => {
  const block = dbSrc.match(/function queryAuditRangeArchiveAware[\s\S]*?\n\}/)[0];
  assert.ok(
    /iterateMonthKeys\s*\(/.test(block),
    "archive-aware audit reader must iterate month keys across [s,e]",
  );
  assert.ok(
    /getArchiveEntry\(monthKey,\s*false\)/.test(block),
    "archive-aware audit reader must use getArchiveEntry(key, false) — LRU stays authoritative; no raw archive opens",
  );
  assert.ok(
    /sortAuditDesc/.test(block),
    "archive-aware audit reader must sort ts DESC to match the operator-log UI contract",
  );
  assert.ok(
    /\.slice\(0,\s*cap\)/.test(block),
    "archive-aware audit reader must apply LIMIT after merge (sort then slice) so old + new co-exist within the cap",
  );
});

test("module.exports surfaces queryAuditRangeArchiveAware", () => {
  assert.ok(
    /queryAuditRangeArchiveAware/.test(dbSrc.split("module.exports")[1] || ""),
    "db.js module.exports must include queryAuditRangeArchiveAware",
  );
});

// ─── Floor hardening ───────────────────────────────────────────────────────
test("auditRetainDays floor bumped from 1 to ≥ 90", () => {
  const pruneBlock = dbSrc.match(/async function pruneOldData[\s\S]*?\n\}\s*\n/)[0];
  // Old code: Math.max(1, ... auditRetainDays ...)
  // New code: Math.max(90, ... auditRetainDays ...)
  assert.ok(
    !/Math\.max\(\s*1\s*,\s*Number\(getSetting\(\s*["']auditRetainDays["']/.test(pruneBlock),
    "REGRESSION: auditRetainDays still uses Math.max(1, …) — that's the same unbounded-floor pattern that caused the alarms bug. Must be at least Math.max(90, …)",
  );
  assert.ok(
    /Math\.max\(\s*90\s*,\s*Number\(getSetting\(\s*["']auditRetainDays["']/.test(pruneBlock),
    "auditRetainDays floor must be 90 days (matches retainDays default; belt-and-braces guard on top of archival)",
  );
});

test("stopReasonsRetainDays floor bumped from 7 to ≥ 90 (matches alarm hot retention)", () => {
  const block = indexSrc.match(/function _prunStopReasonRetention[\s\S]*?\n\}/)[0];
  assert.ok(
    !/Math\.max\(\s*7\s*,\s*Number\(getSetting\(\s*["']stopReasonsRetainDays["']/.test(block),
    "REGRESSION: stopReasonsRetainDays floor is still 7 days — drilldowns would lose stop_reason joins for alarms older than 7d even though the alarm row resolves via archive.",
  );
  assert.ok(
    /Math\.max\(\s*90\s*,\s*Number\(getSetting\(\s*["']stopReasonsRetainDays["']/.test(block),
    "stopReasonsRetainDays floor must be 90 d so alarm drilldowns survive the entire hot-alarm window",
  );
});

// ─── Wire-up ───────────────────────────────────────────────────────────────
test("alarms.js getAuditLog uses the archive-aware reader", () => {
  const block = alarmsSrc.match(/function getAuditLog[\s\S]*?\n\}/)[0];
  assert.ok(
    /queryAuditRangeArchiveAware\(/.test(block),
    "getAuditLog must call queryAuditRangeArchiveAware so /api/audit past-date queries surface archived rows",
  );
  assert.ok(
    !/db\s*\.prepare\([\s\S]*FROM audit_log WHERE/.test(block),
    "getAuditLog must NOT still use hot-only db.prepare(...FROM audit_log...) — that's the path the archive-aware reader replaces",
  );
});

test("alarms.js imports queryAuditRangeArchiveAware from db", () => {
  assert.ok(
    /require\(["']\.\/db["']\)[\s\S]*queryAuditRangeArchiveAware/.test(alarmsSrc) ||
      /queryAuditRangeArchiveAware[\s\S]*?=\s*require\(["']\.\/db["']\)/.test(alarmsSrc),
    "alarms.js must require queryAuditRangeArchiveAware from ./db",
  );
});

console.log(
  "auditArchiveContractShape.test.js: PASS (schema + write-path + read-path + floors + wire-up locked)",
);
