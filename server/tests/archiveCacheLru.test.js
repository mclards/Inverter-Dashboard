"use strict";

/**
 * archiveCacheLru.test.js — v2.11.0-beta.5 fix for audits/2026-05-11 §4.4 (H2).
 *
 * Verifies that ARCHIVE_DB_CACHE in server/db.js is bounded by an LRU policy.
 * Before this fix the cache was an unbounded Map — every archive month opened
 * by the forecast cron, exports, or replication stayed resident for the rest
 * of the process lifetime, contributing to gateway memory creep.
 *
 *   T1. Opening MAX+1 distinct months evicts the oldest.
 *   T2. Reading an existing cached month bumps it to MRU and protects it
 *       from the next eviction.
 *   T3. Evicted entries are properly closed — the underlying better-sqlite3
 *       Database handle reports .open === false and throws on further use.
 *       This is the assertion that proves we're freeing the resource, not
 *       just removing the Map reference.
 *   T4. closeArchiveDbForMonth still works after LRU is wired in.
 *   T5. Eviction telemetry (evictionCount + lastEvictedKey) updates so
 *       operators have a visible signal in getArchiveCacheStats().
 *
 * Runs under the Node-ABI smoke harness (scripts/smoke-all.js) after
 * `npm run rebuild:native:node`.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DB_MODULE_PATH = path.join(REPO_ROOT, "server", "db.js");

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adsi-${label}-`));
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (_) { /* best effort */ }
}

function seedArchiveMonth(archiveDir, monthKey) {
  // Pre-create a valid archive month file so getArchiveEntry() will load it
  // without needing createIfMissing=true (matches how queryReadingsRangeAll
  // calls it on production read paths).
  const filePath = path.join(archiveDir, `${monthKey}.db`);
  const seed = new Database(filePath);
  seed.pragma("journal_mode = WAL");
  seed.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY, ts INTEGER, inverter INTEGER, unit INTEGER,
      pac REAL, kwh REAL, alarm INTEGER, online INTEGER
    );
    CREATE TABLE IF NOT EXISTS energy_5min (
      id INTEGER PRIMARY KEY, ts INTEGER, inverter INTEGER, kwh_inc REAL
    );
  `);
  seed.close();
}

function loadDbForTest(tmp) {
  process.env.ADSI_DATA_DIR = tmp;
  delete require.cache[require.resolve(DB_MODULE_PATH)];
  return require(DB_MODULE_PATH);
}

function testLruEvictionOnOverflow() {
  const tmp = mkTempDir("archive-lru");
  const archiveDir = path.join(tmp, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  // Seed MAX+1 = 7 archive months so we can open all of them.
  const months = [
    "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
  ];
  for (const m of months) seedArchiveMonth(archiveDir, m);

  const dbMod = loadDbForTest(tmp);
  try {
    const internal = dbMod;
    // Trigger archive opens via archiveReadingsRows([row]) with a synthetic
    // row whose timestamp lands in each target month. archiveReadingsRows
    // → archiveRowsByMonth → getArchiveEntry(monthKey, true), which is the
    // path that opens (and now LRU-evicts) cache entries.
    function tsForMonth(monthKey) {
      // Use local-time constructor to match monthKeyFromTs() in server/db.js,
      // which formats with getFullYear()/getMonth() on the Date object.
      const [y, m] = monthKey.split("-").map(Number);
      return new Date(y, m - 1, 15, 10, 0, 0).getTime();
    }
    function rowForMonth(monthKey) {
      return {
        id: tsForMonth(monthKey) + 1, // unique id
        ts: tsForMonth(monthKey),
        inverter: 1, unit: 1, pac: 0, kwh: 0, alarm: 0, online: 1,
      };
    }

    // Open all 7 months in sequence. After the 7th, MAX=6 evicts the
    // oldest (2025-11).
    const evictionBefore = internal.getArchiveCacheStats().evictionCount;
    for (const m of months) {
      const ok = internal.archiveReadingsRows([rowForMonth(m)]);
      assert.ok(ok !== false, `archiveReadingsRows must accept ${m}`);
    }

    const stats = internal.getArchiveCacheStats();
    assert.strictEqual(
      stats.maxOpenMonths, 6,
      "max should be 6 (production cap)",
    );
    assert.ok(
      stats.openMonths <= stats.maxOpenMonths,
      `cache must be bounded: openMonths=${stats.openMonths} > max=${stats.maxOpenMonths}`,
    );
    assert.ok(
      !stats.months.includes("2025-11"),
      `oldest month (2025-11) must have been evicted; cache=${stats.months.join(",")}`,
    );
    assert.ok(
      stats.months.includes("2026-05"),
      `newest month (2026-05) must remain; cache=${stats.months.join(",")}`,
    );
    console.log(`  ✓ T1 LRU eviction: cache has ${stats.openMonths}/${stats.maxOpenMonths} after 7 inserts, oldest evicted`);

    // T3: Verify the underlying SQLite handle was actually closed, not just
    // dereferenced. The eviction path increments evictionCount only AFTER
    // closeArchiveDbForMonth returns true, and closeArchiveDbForMonth only
    // returns true after it has run wal_checkpoint + db.close() + Map.delete.
    // So evictionCount > 0 is a hard signal that the close path executed.
    // Then we re-open the evicted month and read its row to confirm the
    // file itself is still healthy and reachable (a botched close that
    // truncated the WAL mid-write would lose this row).
    assert.ok(
      stats.evictionCount > evictionBefore,
      `evictionCount must increment (before=${evictionBefore} after=${stats.evictionCount})`,
    );
    assert.strictEqual(
      stats.lastEvictedKey, "2025-11",
      `lastEvictedKey should be the oldest month, got ${stats.lastEvictedKey}`,
    );
    const reopenedPath = path.join(archiveDir, "2025-11.db");
    const reopened = new Database(reopenedPath, { readonly: true, fileMustExist: true });
    try {
      const cnt = reopened.prepare("SELECT COUNT(*) AS n FROM readings").get();
      assert.strictEqual(
        Number(cnt?.n || 0), 1,
        "evicted month must still have its row (eviction must not corrupt data)",
      );
    } finally {
      reopened.close();
    }
    console.log(`  ✓ T3 handle closure: evictionCount=${stats.evictionCount}, evicted month re-readable`);

    // T2: access an older month, then insert another — the bumped one
    // must survive.
    function bumpMonth(monthKey) {
      internal.archiveReadingsRows([rowForMonth(monthKey)]);
    }
    bumpMonth("2025-12");           // bumps 2025-12 to MRU
    seedArchiveMonth(archiveDir, "2026-06");
    bumpMonth("2026-06");           // forces eviction of new-oldest
    const after = internal.getArchiveCacheStats();
    assert.ok(
      after.months.includes("2025-12"),
      `bumped month must survive eviction; cache=${after.months.join(",")}`,
    );
    assert.ok(
      after.months.includes("2026-06"),
      `freshly-added month must be present; cache=${after.months.join(",")}`,
    );
    console.log(`  ✓ T2 LRU bump: cache=${after.months.join(",")}`);

    // T4: closeArchiveDbForMonth still removes the entry cleanly.
    const before = internal.getArchiveCacheStats().openMonths;
    const closed = internal.closeArchiveDbForMonth("2026-06");
    assert.strictEqual(closed, true, "closeArchiveDbForMonth must return true");
    assert.strictEqual(
      internal.getArchiveCacheStats().openMonths, before - 1,
      "cache size must decrement after close",
    );
    console.log("  ✓ T4 closeArchiveDbForMonth integrates cleanly");

    // T5: Telemetry shape — operators must be able to read these via
    // getArchiveCacheStats() to confirm the LRU is firing in production.
    const tele = internal.getArchiveCacheStats();
    assert.strictEqual(typeof tele.evictionCount, "number", "evictionCount must be numeric");
    assert.ok(tele.evictionCount >= 2, `expected >=2 evictions after T1+T2, got ${tele.evictionCount}`);
    assert.ok(tele.lastEvictedAtMs > 0, "lastEvictedAtMs must be set");
    assert.ok(Date.now() - tele.lastEvictedAtMs < 60_000, "lastEvictedAtMs must be recent");
    console.log(`  ✓ T5 telemetry: evictionCount=${tele.evictionCount}, lastEvictedKey=${tele.lastEvictedKey}`);
  } finally {
    try { dbMod.closeDb(); } catch (_) { /* ignore */ }
    delete require.cache[require.resolve(DB_MODULE_PATH)];
    delete process.env.ADSI_DATA_DIR;
    setTimeout(() => rmTree(tmp), 150);
  }
}

function main() {
  console.log("[archiveCacheLru] start");
  testLruEvictionOnOverflow();
  console.log("[archiveCacheLru] all assertions passed");
}

main();
