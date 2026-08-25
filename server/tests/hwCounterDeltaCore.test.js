"use strict";

// Regression test for the Energy Summary export's hardware-counter delta
// math (Etotal_kWh / parcE_kWh per unit per day). Locks down the multi-path
// fallback rules introduced in v2.10.x:
//
//   TODAY:
//     1. baseline-anchored delta (any source: eod_clean | poll | pac_seed)
//     2. yesterday's eod_clean as fallback anchor when today's row missing
//   PAST DAY D:
//     1. same-day eod_clean − baseline
//     2. tomorrow's baseline − today's baseline (close-out fallback)
//   Sanity ceiling — every accepted delta must be ≥0 and ≤9000 kWh/unit/day.
//
// These were previously locked only via a hand-traced inline closure inside
// server/exporter.js — refactored into hwCounterDeltaCore.js so we can prove
// behavior without touching SQLite.

const assert = require("assert");
const {
  DEFAULT_PER_UNIT_DAY_CEILING_KWH,
  acceptDelta,
  computeHwDeltasForUnitDay,
} = require("../hwCounterDeltaCore");

function approx(actual, expected, tol = 1e-6, msg = "") {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ≈${expected} got ${actual} (tol=${tol})`,
  );
}

function isNaNValue(x) {
  return typeof x === "number" && Number.isNaN(x);
}

const TODAY = "2026-04-28";
const YESTERDAY = "2026-04-27";
const PAST = "2026-04-20";

function run() {
  // ── 1. acceptDelta sanity ─────────────────────────────────────────────
  {
    assert.strictEqual(acceptDelta(0), true, "0 kWh accepted");
    assert.strictEqual(acceptDelta(123.4), true, "normal delta accepted");
    assert.strictEqual(acceptDelta(-1), false, "negative rejected");
    assert.strictEqual(acceptDelta(NaN), false, "NaN rejected");
    assert.strictEqual(acceptDelta(Infinity), false, "Infinity rejected");
    assert.strictEqual(
      acceptDelta(DEFAULT_PER_UNIT_DAY_CEILING_KWH),
      true,
      "ceiling exactly accepted",
    );
    assert.strictEqual(
      acceptDelta(DEFAULT_PER_UNIT_DAY_CEILING_KWH + 0.001),
      false,
      "above ceiling rejected",
    );
    assert.strictEqual(acceptDelta(50, 100), true, "custom ceiling 100 accepts 50");
    assert.strictEqual(acceptDelta(150, 100), false, "custom ceiling 100 rejects 150");
  }

  // ── 2. TODAY path 1 — baseline-anchored delta (any source) ────────────
  // Even a 'poll' baseline at 11:52 must produce a usable delta — the
  // export pre-v2.10.x bug was that anything other than 'eod_clean' got
  // blanked, leaving operators with empty HW columns on a perfectly polled
  // morning. Lock the fix.
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: {
        etotal_baseline: 1_000_000,
        parce_baseline:    50_000,
        source: "poll",
      },
      curCounter: { etotal_kwh: 1_000_125, parce_kwh: 50_087.5 },
    });
    approx(out.etotalKwh, 125,    1e-6, "today path 1: Etotal delta from poll baseline");
    approx(out.parceKwh,   87.5,  1e-6, "today path 1: parcE delta from poll baseline");
  }

  // ── 3. TODAY path 1 with eod_clean baseline (most common, post-1800H) ─
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: {
        etotal_baseline: 2_345_678,
        parce_baseline:    98_765,
        source: "eod_clean",
      },
      curCounter: { etotal_kwh: 2_345_900, parce_kwh: 98_888 },
    });
    approx(out.etotalKwh, 222,   1e-6, "today: eod_clean baseline yields clean Etotal");
    approx(out.parceKwh,  123,   1e-6, "today: eod_clean baseline yields clean parcE");
  }

  // ── 4. TODAY path 2 — yesterday's eod_clean as fallback anchor ────────
  // Gateway booted today, never wrote a today-baseline row, but yesterday's
  // snapshot is intact. Must close the gap so the column isn't empty.
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: null,
      curCounter: { etotal_kwh: 1_001_500, parce_kwh: 50_400 },
      yesterdayBaseline: {
        etotal_baseline:  999_000,
        etotal_eod_clean: 1_001_000,
        parce_baseline:    49_500,
        parce_eod_clean:   50_200,
        source: "eod_clean",
      },
    });
    approx(out.etotalKwh, 500, 1e-6, "today path 2: cur − yesterday.eod_clean Etotal");
    approx(out.parceKwh,  200, 1e-6, "today path 2: cur − yesterday.eod_clean parcE");
  }

  // ── 5. TODAY path 2 — yesterday eod_clean only zero/missing in one half
  // parcE eod_clean was zero (cleared between days), Etotal still works.
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: null,
      curCounter: { etotal_kwh: 1_001_500, parce_kwh: 50_400 },
      yesterdayBaseline: {
        etotal_baseline:  999_000,
        etotal_eod_clean: 1_001_000,
        parce_baseline:        0,
        parce_eod_clean:       0,
      },
    });
    approx(out.etotalKwh, 500, 1e-6, "yesterday partial: Etotal still anchored");
    assert.ok(isNaNValue(out.parceKwh), "yesterday partial: parcE NaN-propagates");
  }

  // ── 6. TODAY both paths missing — every column empty (no half-truth) ─
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: null,
      curCounter: { etotal_kwh: 1_001_500, parce_kwh: 50_400 },
      yesterdayBaseline: null,
    });
    assert.ok(isNaNValue(out.etotalKwh), "no anchors: Etotal NaN");
    assert.ok(isNaNValue(out.parceKwh),  "no anchors: parcE NaN");
  }

  // ── 7. TODAY snapshot missing entirely (Python service down) ──────────
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: { etotal_baseline: 1_000_000, parce_baseline: 50_000 },
      curCounter: null,
      yesterdayBaseline: { etotal_eod_clean: 1_001_000, parce_eod_clean: 50_500 },
    });
    assert.ok(isNaNValue(out.etotalKwh), "no curCounter: Etotal NaN");
    assert.ok(isNaNValue(out.parceKwh),  "no curCounter: parcE NaN");
  }

  // ── 8. PAST DAY path 1 — same-day eod_clean delta (the v2.9.x rule) ──
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: {
        etotal_baseline: 1_000_000,
        etotal_eod_clean: 1_000_180,
        parce_baseline:     50_000,
        parce_eod_clean:    50_175,
        source: "eod_clean",
      },
    });
    approx(out.etotalKwh, 180, 1e-6, "past path 1: Etotal eod_clean delta");
    approx(out.parceKwh,  175, 1e-6, "past path 1: parcE eod_clean delta");
  }

  // ── 9. PAST DAY path 2 — tomorrow's baseline closes a missed eod_clean
  // Gateway was offline 17:30→05:30 next day. eod_clean[D] never captured,
  // but D+1's sunrise baseline IS captured. That open ≈ D's close.
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: {
        etotal_baseline: 1_000_000,
        parce_baseline:     50_000,
        source: "poll",
        // no eod_clean — gateway died before 18:00
      },
      tomorrowBaseline: {
        etotal_baseline: 1_000_222,
        parce_baseline:     50_211,
      },
    });
    approx(out.etotalKwh, 222, 1e-6, "past path 2: Etotal close-out from D+1 baseline");
    approx(out.parceKwh,  211, 1e-6, "past path 2: parcE close-out from D+1 baseline");
  }

  // ── 10. PAST DAY mixed — Etotal eod_clean fine, parcE missing → D+1 ──
  // parcE was reset to 0 mid-day (alarm clear), so eod_clean=0 on D, but
  // D+1's baseline was captured cleanly → parcE close-out via fallback.
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: {
        etotal_baseline: 1_000_000,
        etotal_eod_clean: 1_000_180,  // valid
        parce_baseline:     50_000,
        parce_eod_clean:        0,    // missing
      },
      tomorrowBaseline: {
        etotal_baseline: 1_000_180,
        parce_baseline:        50,    // small overnight drift
      },
    });
    approx(out.etotalKwh, 180, 1e-6, "past mixed: Etotal from path 1");
    // parcE went 50_000 → 50 → cleared → tomorrow opens at 50 → delta=50-50_000=-49_950 (rejected as negative)
    assert.ok(
      isNaNValue(out.parceKwh),
      "past mixed: parcE rejected when D+1 baseline lower than D (post-clear)",
    );
  }

  // ── 11. PAST DAY no baseline at all → both NaN ─────────────────────────
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: null,
      tomorrowBaseline: { etotal_baseline: 1, parce_baseline: 1 },
    });
    assert.ok(isNaNValue(out.etotalKwh), "no baseline: Etotal NaN");
    assert.ok(isNaNValue(out.parceKwh),  "no baseline: parcE NaN");
  }

  // ── 12. Sanity ceiling — bogus runaway counter rejected ───────────────
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: { etotal_baseline: 1_000_000, parce_baseline: 50_000 },
      // Counter tripled overnight — clearly a parser hiccup, not real energy.
      // 9001 kWh > ceiling → must be rejected, NOT exported as a 9 MWh row.
      curCounter: { etotal_kwh: 1_009_001, parce_kwh: 51_000 },
    });
    assert.ok(isNaNValue(out.etotalKwh), "ceiling: 9001 kWh rejected");
    approx(out.parceKwh, 1000, 1e-6, "ceiling: parcE 1000 kWh accepted");
  }

  // ── 13. Sanity floor — counter went BACKWARDS (firmware reset) ────────
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: { etotal_baseline: 1_000_000, parce_baseline: 50_000 },
      curCounter: { etotal_kwh: 999_995, parce_kwh: 49_900 },
    });
    assert.ok(isNaNValue(out.etotalKwh), "negative delta: Etotal rejected");
    assert.ok(isNaNValue(out.parceKwh),  "negative delta: parcE rejected");
  }

  // ── 14. Custom ceiling threading ─────────────────────────────────────
  // Plant Cap deployments may want a tighter ceiling than 9000.
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: { etotal_baseline: 1_000_000, parce_baseline: 50_000 },
      curCounter: { etotal_kwh: 1_000_500, parce_kwh: 50_300 },
      perUnitDayCeilingKwh: 250, // tighter than 500 kWh delta
    });
    assert.ok(isNaNValue(out.etotalKwh), "custom ceiling 250: 500 rejected");
    assert.ok(isNaNValue(out.parceKwh),  "custom ceiling 250: 300 rejected");
  }

  // ── 15. TODAY path 1 produces zero for one half, fallback fills other ─
  // Today's baseline matches Etotal exactly (counter hadn't ticked yet at
  // baseline time), but parcE has moved. Both halves should report — the
  // 0-delta on Etotal is valid, not a "no usable delta" trigger that hops
  // to the yesterday fallback. Locks the path-1 short-circuit semantics.
  {
    const out = computeHwDeltasForUnitDay({
      day: TODAY,
      today: TODAY,
      baseline: { etotal_baseline: 1_000_000, parce_baseline: 50_000 },
      curCounter: { etotal_kwh: 1_000_000, parce_kwh: 50_050 },
      yesterdayBaseline: {
        // If we wrongly fell through to path 2, this would yield 1500/100,
        // which would mis-attribute energy. Test guards against that.
        etotal_eod_clean: 998_500,
        parce_eod_clean:   49_950,
      },
    });
    approx(out.etotalKwh, 0,  1e-9, "today path 1 short-circuits at 0 Etotal");
    approx(out.parceKwh,  50, 1e-6, "today path 1 reports parcE delta");
  }

  // ── 16. PAST DAY source='eod_clean_only' → both halves NaN ──────────
  // Late-created rows from the dark-window capture have baseline = eod_clean
  // as a placeholder so the row can anchor TOMORROW. The same-day Δ is
  // unknown (we have no morning data) and must NaN-propagate, NOT report 0.
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: {
        source: "eod_clean_only",
        etotal_baseline:  1_000_000,
        etotal_eod_clean: 1_000_000,  // equal to baseline (placeholder)
        parce_baseline:     50_000,
        parce_eod_clean:    50_000,
      },
      tomorrowBaseline: { etotal_baseline: 1_000_180, parce_baseline: 50_175 },
    });
    assert.ok(isNaNValue(out.etotalKwh), "eod_clean_only: Etotal NaN-propagates");
    assert.ok(isNaNValue(out.parceKwh),  "eod_clean_only: parcE NaN-propagates");
  }

  // ── 17. PAST DAY source='eod_clean_only' (case-insensitive guard) ───
  {
    const out = computeHwDeltasForUnitDay({
      day: PAST,
      today: TODAY,
      baseline: {
        source: "EOD_CLEAN_ONLY",
        etotal_baseline:  1_000_000,
        etotal_eod_clean: 1_000_000,
        parce_baseline:     50_000,
        parce_eod_clean:    50_000,
      },
    });
    assert.ok(isNaNValue(out.etotalKwh), "uppercase variant also matched");
    assert.ok(isNaNValue(out.parceKwh));
  }

  console.log("hwCounterDeltaCore.test.js — all 17 scenarios passed.");
}

run();
