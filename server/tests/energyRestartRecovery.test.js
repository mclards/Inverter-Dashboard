"use strict";

/**
 * energyRestartRecovery.test.js — Tier 0.1 of
 * audits/2026-05-30/energy-logging-integrity-hardening.md
 *
 * energy_5min is committed only at 5-min slot rollover, so the in-progress slot
 * lives only in memory until then. A freeze that ends in a hard kill (the event
 * loop is frozen, so poller.flushPending()'s graceful partial-flush can never
 * run) loses that slot plant-wide — but the raw `readings` survive.
 * recoverTodayEnergyFromReadings() re-integrates PAC from those readings into
 * any COMPLETED today slot that is missing from energy_5min, at gateway boot,
 * before live integration resumes.
 *
 * This test exercises the failure the operator reported — energy lost on a
 * freeze/kill — and the three properties that make the fix safe to ship:
 *
 *   T1. Gap-fill: a completed slot that has readings but no energy_5min row is
 *       backfilled with the PAC-integrated value (matches a reference integrator
 *       running the identical buildPacEnergyBuckets math).
 *   T2. No overwrite: a completed slot that ALREADY has an energy_5min row is
 *       left exactly as-is (value unchanged, still exactly one row) — proves the
 *       idempotency guard, since energy_5min has no UNIQUE(ts,inverter).
 *   T3. In-progress slot is never touched (the live poller owns it) — no
 *       duplicate-row / double-count race with the writer that starts right after.
 *   T4. Idempotent: a second call recovers nothing and creates no duplicate rows.
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
const FIVE_MIN = 5 * 60 * 1000;
const dtCapSec = 30;

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adsi-${label}-`));
}
function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
function loadDbForTest(tmp) {
  process.env.ADSI_DATA_DIR = tmp;
  delete require.cache[require.resolve(DB_MODULE_PATH)];
  return require(DB_MODULE_PATH);
}

// Reference integrator: the EXACT algorithm recoverTodayEnergyFromReadings (and
// buildPacEnergyBuckets) use. Used to compute the expected backfill value, which
// guards against window-bounds / column / bucket-key regressions in recovery.
function refIntegrate(readingRows, dayStart, windowEnd) {
  const nodeState = new Map();
  const bucketMap = new Map();
  for (const r of readingRows) {
    const ts = Number(r.ts || 0);
    if (!(ts >= dayStart && ts <= windowEnd)) continue;
    const inv = Number(r.inverter || 0);
    const unit = Number(r.unit || 0);
    if (!inv || !unit || !ts) continue;
    const key = `${inv}_${unit}`;
    const online = Number(r.online || 0) === 1;
    const pacW = Math.max(0, Number(online ? r.pac : 0) || 0);
    const prev = nodeState.get(key);
    if (prev && ts > prev.ts) {
      const dtRaw = (ts - prev.ts) / 1000;
      if (dtRaw > 0) {
        const dt = Math.min(dtCapSec, dtRaw);
        const avg = (Number(prev.pac || 0) + pacW) / 2;
        const k = (avg * dt) / 3600000;
        if (k > 0) {
          const b = Math.floor(ts / FIVE_MIN) * FIVE_MIN;
          const bk = `${inv}|${b}`;
          bucketMap.set(bk, Number(bucketMap.get(bk) || 0) + k);
        }
      }
    }
    nodeState.set(key, { ts, pac: pacW });
  }
  return bucketMap;
}

function main() {
  console.log("[energyRestartRecovery] start");
  const tmp = mkTempDir("energy-recovery");
  const dbMod = loadDbForTest(tmp);
  let seed = null;
  try {
    // Fixed "now" at 11:07:30 local → current (in-progress) slot starts 11:05:00.
    const base = new Date();
    base.setHours(11, 7, 30, 0);
    const now = base.getTime();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    const currentSlotStart = Math.floor(now / FIVE_MIN) * FIVE_MIN;
    const windowEnd = currentSlotStart - 1;

    const slotA = dayStartMs + 10 * 60 * 60 * 1000;            // 10:00:00 (completed, PRESENT w/ sentinel)
    const slotB = slotA + FIVE_MIN;                            // 10:05:00 (completed, the LOST gap)
    assert.ok(slotB < currentSlotStart, "slotB must be a completed slot");

    // Build a continuous 10 s PAC stream (constant 360 kW) spanning slot A, slot
    // B, every following completed slot, and into the in-progress slot. 360000 W
    // over a 10 s capped interval = 1.0 kWh per interval — non-trivial, physical.
    const PAC = 360000;
    const readings = [];
    for (let ts = slotA; ts <= currentSlotStart + 90 * 1000; ts += 10 * 1000) {
      readings.push({ ts, inverter: 1, unit: 1, pac: PAC, kwh: 0, alarm: 0, online: 1 });
    }

    // Reference buckets for the recovery window (the exact set recovery sees).
    const expected = refIntegrate(readings, dayStartMs, windowEnd);
    const expectedB = Number(Number(expected.get(`1|${slotB}`) || 0).toFixed(6));
    assert.ok(expectedB > 0, `reference integral for slot B must be > 0 (got ${expectedB})`);

    // Seed hot tables directly (full control; no daily-summary side effects).
    // Pre-commit EVERY completed bucket EXCEPT slotB, so slotB is the single
    // "lost" slot a freeze/kill would have dropped. slotA gets a deliberately
    // wrong sentinel value (99.0) so we can prove recovery does NOT overwrite an
    // already-present slot.
    seed = new Database(path.join(tmp, "adsi.db"));
    const insReading = seed.prepare(
      "INSERT INTO readings(ts,inverter,unit,pac,kwh,alarm,online) VALUES(?,?,?,?,?,?,?)",
    );
    const insEnergy = seed.prepare(
      "INSERT INTO energy_5min(ts,inverter,kwh_inc) VALUES(?,?,?)",
    );
    seed.transaction(() => {
      for (const r of readings) insReading.run(r.ts, r.inverter, r.unit, r.pac, r.kwh, r.alarm, r.online);
      for (const [bKey, kwh] of expected.entries()) {
        const [invStr, tsStr] = bKey.split("|");
        const ts = Number(tsStr);
        if (ts === slotB) continue; // leave the one gap
        insEnergy.run(ts, Number(invStr), ts === slotA ? 99.0 : Number(Number(kwh).toFixed(6)));
      }
    })();

    const countSlot = (ts) =>
      Number(seed.prepare("SELECT COUNT(*) AS n FROM energy_5min WHERE ts=? AND inverter=1").get(ts).n);
    const valSlot = (ts) => {
      const row = seed.prepare("SELECT kwh_inc FROM energy_5min WHERE ts=? AND inverter=1").get(ts);
      return row ? Number(row.kwh_inc) : null;
    };

    // Pre-conditions: exactly one gap (slotB); slotA present with sentinel.
    assert.strictEqual(countSlot(slotA), 1, "slot A seeded present");
    assert.strictEqual(valSlot(slotA), 99.0, "slot A seeded with sentinel 99.0");
    assert.strictEqual(countSlot(slotB), 0, "slot B (the lost slot) starts absent");

    // ── Run recovery ──
    const r1 = dbMod.recoverTodayEnergyFromReadings(now);

    // T1: gap-filled with the integrated value.
    assert.strictEqual(countSlot(slotB), 1, "T1: slot B must be backfilled exactly once");
    assert.strictEqual(valSlot(slotB), expectedB, `T1: slot B kwh must equal reference integral ${expectedB}`);
    console.log(`  ✓ T1 gap-fill: slot B backfilled with ${expectedB} kWh`);

    // T2: existing slot untouched.
    assert.strictEqual(countSlot(slotA), 1, "T2: slot A must remain a single row");
    assert.strictEqual(valSlot(slotA), 99.0, "T2: slot A value must be unchanged (no overwrite)");
    console.log("  ✓ T2 no-overwrite: pre-existing slot A left at 99.0");

    // T3: in-progress slot never written.
    assert.strictEqual(countSlot(currentSlotStart), 0, "T3: in-progress slot must never be recovered");
    assert.ok(r1 && r1.recovered === 1, `T3: exactly one slot recovered (got ${r1 && r1.recovered})`);
    console.log("  ✓ T3 in-progress slot excluded; recovered=1");

    // T4: idempotent — second run is a no-op, no duplicate rows.
    const r2 = dbMod.recoverTodayEnergyFromReadings(now);
    assert.ok(r2 && r2.recovered === 0, `T4: second run must recover nothing (got ${r2 && r2.recovered})`);
    assert.strictEqual(countSlot(slotB), 1, "T4: slot B must still be exactly one row (no duplicate)");
    assert.strictEqual(countSlot(slotA), 1, "T4: slot A must still be exactly one row");
    console.log("  ✓ T4 idempotent: re-run recovered 0, no duplicate rows");

    console.log("[energyRestartRecovery] all assertions passed");
  } finally {
    try { if (seed) seed.close(); } catch (_) { /* ignore */ }
    try { dbMod.closeDb(); } catch (_) { /* ignore */ }
    delete require.cache[require.resolve(DB_MODULE_PATH)];
    delete process.env.ADSI_DATA_DIR;
    setTimeout(() => rmTree(tmp), 150);
  }
}

main();
