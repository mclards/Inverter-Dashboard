"use strict";

// Locks the v2.10.x retroactive baseline upgrade decision so the
// dark-window capture can never silently fail to fix a 'poll' day on a
// fresh-boot or dashboard-was-down-yesterday scenario.

const assert = require("assert");
const {
  SOURCE_EOD_CLEAN,
  SOURCE_EOD_CLEAN_ONLY,
  SOURCE_POLL,
  shouldUpgradeBaselineToEodClean,
} = require("../baselineUpgradeCore");

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg || "");
}

function run() {
  // ── 1. Happy path — today is 'poll', yesterday has clean close, current
  //    Etotal advances cleanly past yesterday's close. Upgrade fires. ───
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL, etotal_baseline: 1_000_500 },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000,
        parce_eod_clean:    50_000,
        eod_clean_ts_ms:  Date.now() - 12 * 3600_000,
      },
      currentEtotalKwh: 1_000_750,
    });
    assert.strictEqual(r.upgrade, true);
    assert.strictEqual(r.newBaseline.etotal, 1_000_000);
    assert.strictEqual(r.newBaseline.parce,    50_000);
    assert.ok(r.reason.includes("upgrading today poll"));
  }

  // ── 2. Today already 'eod_clean' — no-op ────────────────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_EOD_CLEAN },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000, parce_eod_clean: 50_000,
        eod_clean_ts_ms: Date.now(),
      },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.ok(r.reason.includes("not 'poll'"));
  }

  // ── 3. Today is 'eod_clean_only' (late-created) — should NOT upgrade
  //    because eod_clean_only rows are only valid as next-day anchors,
  //    not as today's morning baseline. ──────────────────────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_EOD_CLEAN_ONLY },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000, parce_eod_clean: 50_000,
        eod_clean_ts_ms: Date.now(),
      },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.ok(r.reason.includes("not 'poll'"));
  }

  // ── 4. No today row — no-op ─────────────────────────────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: null,
      yesterdayRow: { etotal_eod_clean: 1_000_000, eod_clean_ts_ms: 1 },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.strictEqual(r.reason, "no today row");
  }

  // ── 5. No yesterday row — no-op ─────────────────────────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: null,
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.strictEqual(r.reason, "no yesterday row");
  }

  // ── 6. Yesterday eod_clean missing (NULL/0) — no-op ─────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: { etotal_eod_clean: 0, eod_clean_ts_ms: Date.now() },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.ok(r.reason.includes("eod_clean missing"));
  }

  // ── 7. Yesterday eod_clean_ts_ms missing — no-op (defensive) ────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: { etotal_eod_clean: 1_000_000, eod_clean_ts_ms: 0 },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, false);
    assert.ok(r.reason.includes("ts missing"));
  }

  // ── 8. Yesterday eod_clean GREATER than current Etotal — REFUSE ─────
  // Counter regression — refusing to anchor protects the export from
  // negative deltas getting clamped silently.
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: {
        etotal_eod_clean: 1_000_500,  // GREATER than current
        eod_clean_ts_ms: Date.now(),
      },
      currentEtotalKwh: 1_000_400,    // current < yesterday's close
    });
    assert.strictEqual(r.upgrade, false);
    assert.ok(r.reason.includes("regression") || r.reason.includes(">"),
      "reason mentions regression");
  }

  // ── 9. Current Etotal invalid (NaN, 0, negative) — no-op ────────────
  {
    for (const cur of [NaN, 0, -1, "abc"]) {
      const r = shouldUpgradeBaselineToEodClean({
        todayRow: { source: SOURCE_POLL },
        yesterdayRow: {
          etotal_eod_clean: 1_000_000, eod_clean_ts_ms: Date.now(),
        },
        currentEtotalKwh: cur,
      });
      assert.strictEqual(r.upgrade, false, `current=${cur} → no upgrade`);
      assert.ok(r.reason.includes("current etotal invalid"));
    }
  }

  // ── 10. Equality boundary — yesterday eod_clean === current — accept
  // (counter sat idle through the night, no production yet today)
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000,
        parce_eod_clean:    50_000,
        eod_clean_ts_ms: Date.now() - 6 * 3600_000,
      },
      currentEtotalKwh: 1_000_000, // exactly equal
    });
    assert.strictEqual(r.upgrade, true, "equality is monotone-acceptable");
    assert.strictEqual(r.newBaseline.etotal, 1_000_000);
  }

  // ── 11. Source comparison is case-insensitive ───────────────────────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: "POLL" },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000, eod_clean_ts_ms: Date.now(),
      },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, true, "uppercase 'POLL' still matches");
  }

  // ── 12. parcE missing on yesterday — still upgrades; parcE part of
  //    new baseline becomes 0 (parcE may legitimately be absent) ─────
  {
    const r = shouldUpgradeBaselineToEodClean({
      todayRow: { source: SOURCE_POLL },
      yesterdayRow: {
        etotal_eod_clean: 1_000_000,
        parce_eod_clean:  null,  // absent
        eod_clean_ts_ms: Date.now(),
      },
      currentEtotalKwh: 1_000_500,
    });
    assert.strictEqual(r.upgrade, true);
    assert.strictEqual(r.newBaseline.etotal, 1_000_000);
    assert.strictEqual(r.newBaseline.parce, 0);
  }

  console.log("baselineUpgradeCore.test.js — all 12 scenarios passed.");
}

run();
