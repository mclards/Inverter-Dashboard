"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  decideBaselineAnchor,
  DEFAULT_PAC_WAKE_THRESHOLD_W,
} = require("../baselineAnchorDecisionCore");

console.log("\n  baselineAnchorDecisionCore.test.js — Slice η baseline anchoring\n");

const T_NOW    = 1_700_000_000_000;
const T_YESTER = T_NOW - 86_400_000;

// Small helper to build the yesterday eod_clean row shape.
function eodClean({ etotal, parce = etotal, ts = T_YESTER + 18 * 3600 * 1000 }) {
  return { etotal_eod_clean: etotal, parce_eod_clean: parce, eod_clean_ts_ms: ts };
}

/* ── Path 1 — yesterday eod_clean is the gold standard ─────────────────── */

test("eod_clean: anchors on yesterday's clean snapshot when present", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: 4_014_400,
    curParceKwh:  1_617_600,
    curTsMs:      T_NOW + 5 * 3600 * 1000,   // 5 AM
    curPacW:      0,
    yesterdayEodClean: eodClean({ etotal: 4_014_300, parce: 1_617_500 }),
  });
  assert.equal(d.source, "eod_clean");
  assert.equal(d.etotalBaseline, 4_014_300);
  assert.equal(d.parceBaseline, 1_617_500);
});

test("eod_clean: anchors even when inverter is already producing (PAC > wake)", () => {
  // Late-boot scenario but the snapshot exists — eod_clean wins.
  const d = decideBaselineAnchor({
    curEtotalKwh: 4_014_500,
    curParceKwh:  1_617_700,
    curTsMs:      T_NOW + 9 * 3600 * 1000,
    curPacW:      150_000,
    yesterdayEodClean: eodClean({ etotal: 4_014_300, parce: 1_617_500 }),
  });
  assert.equal(d.source, "eod_clean");
});

test("eod_clean: refuses if yesterday > today (counter monotonicity guard)", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: 4_014_300,        // less than yesterday
    curParceKwh:  1_617_500,
    curTsMs:      T_NOW + 5 * 3600 * 1000,
    curPacW:      0,
    yesterdayEodClean: eodClean({ etotal: 4_014_400 }),
  });
  // Falls through — no PAC, so cold-start poll wins.
  assert.equal(d.source, "poll");
});

/* ── Path 2 — poll_late: gateway booted after sunrise, no eod_clean ───── */

test("poll_late: PAC > wake AND no yesterday snapshot → poll_late", () => {
  // Inv 12 Node 3 production case: PAC 1.10 MWh / Etotal Δ 0.574 MWh ≈ 47%.
  const d = decideBaselineAnchor({
    curEtotalKwh: 4_014_354,
    curParceKwh:  1_617_543,
    curTsMs:      T_NOW + 8 * 3600 * 1000,   // 8 AM boot
    curPacW:      140_400,                    // already producing
    yesterdayEodClean: null,
  });
  assert.equal(d.source, "poll_late");
  assert.match(d.reason, /pac=140400W>threshold/);
  // We still record what we observed (so the row has *some* anchor for the
  // export to find), but hwCounterDeltaCore treats poll_late as NaN.
  assert.equal(d.etotalBaseline, 4_014_354);
  assert.equal(d.parceBaseline, 1_617_543);
});

test("poll_late: PAC > wake even with empty (zeroed) yesterday row → poll_late", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: 100_000,
    curParceKwh:  50_000,
    curTsMs:      T_NOW + 9 * 3600 * 1000,
    curPacW:      80_000,
    yesterdayEodClean: { etotal_eod_clean: 0, parce_eod_clean: 0, eod_clean_ts_ms: 0 },
  });
  assert.equal(d.source, "poll_late");
});

/* ── Path 3 — cold-start poll: idle inverter, no snapshot → safe to anchor */

test("poll: cold start before sunrise → first poll is the baseline", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: 100_000,
    curParceKwh:  50_000,
    curTsMs:      T_NOW + 4 * 3600 * 1000,
    curPacW:      0,
    yesterdayEodClean: null,
  });
  assert.equal(d.source, "poll");
  assert.equal(d.etotalBaseline, 100_000);
});

test("poll: PAC at noise floor (< 50 W default) → still safe to anchor", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: 100_000,
    curParceKwh:  50_000,
    curTsMs:      T_NOW + 5 * 3600 * 1000,
    curPacW:      30,
    yesterdayEodClean: null,
  });
  assert.equal(d.source, "poll");
});

test("poll: tunable wake threshold honored", () => {
  // Tighter 10 W threshold reclassifies the 30 W frame as poll_late.
  const d = decideBaselineAnchor({
    curEtotalKwh: 100_000,
    curParceKwh:  50_000,
    curTsMs:      T_NOW + 5 * 3600 * 1000,
    curPacW:      30,
    yesterdayEodClean: null,
    pacWakeThresholdW: 10,
  });
  assert.equal(d.source, "poll_late");
});

/* ── Defensive paths ───────────────────────────────────────────────────── */

test("invalid_inputs: NaN curEtotalKwh → poll_late sentinel", () => {
  const d = decideBaselineAnchor({
    curEtotalKwh: NaN,
    curParceKwh:  0,
    curTsMs:      T_NOW,
    curPacW:      0,
    yesterdayEodClean: null,
  });
  assert.equal(d.source, "poll_late");
  assert.equal(d.reason, "invalid_inputs");
});

test("DEFAULT_PAC_WAKE_THRESHOLD_W exposed at 50 W (matches db.js eod-clean gate)", () => {
  assert.equal(DEFAULT_PAC_WAKE_THRESHOLD_W, 50);
});

/* ── Round-trip with hwCounterDeltaCore: poll_late blanks the export Δ ── */

test("INTEGRATION GUARD: poll_late row produces NaN Δ in hwCounterDeltaCore", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  // Today path
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: {
      etotal_baseline: 4_014_354,
      parce_baseline:  1_617_543,
      source: "poll_late",
    },
    curCounter: { etotal_kwh: 4_015_000, parce_kwh: 1_618_000 },
  });
  assert.ok(Number.isNaN(r.etotalKwh), "etotalKwh must NaN");
  assert.ok(Number.isNaN(r.parceKwh),  "parceKwh must NaN");

  // Past-day path
  const past = computeHwDeltasForUnitDay({
    day: "2026-05-10", today,
    baseline: {
      etotal_baseline: 4_014_354,
      etotal_eod_clean: 4_015_000,
      parce_baseline: 1_617_543,
      parce_eod_clean: 1_618_000,
      source: "poll_late",
    },
  });
  assert.ok(Number.isNaN(past.etotalKwh), "past-day etotalKwh must NaN");
  assert.ok(Number.isNaN(past.parceKwh),  "past-day parceKwh must NaN");
});

test("INTEGRATION GUARD: 'poll' (cold start) still produces normal Δ", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: { etotal_baseline: 100_000, parce_baseline: 50_000, source: "poll" },
    curCounter: { etotal_kwh: 100_500, parce_kwh: 50_500 },
  });
  assert.equal(r.etotalKwh, 500);
  assert.equal(r.parceKwh, 500);
  assert.equal(r.provenance, "hw_counter");
});

/* ── PAC-fallback path (2026-05-11 operator request) ──────────────────── */

test("PAC fallback: poll_late + pacFallbackKwh → HW Δ = PAC Δ, provenance='pac_fallback'", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: {
      etotal_baseline: 4_014_354,
      parce_baseline:  1_617_543,
      source: "poll_late",
    },
    curCounter: { etotal_kwh: 4_015_000, parce_kwh: 1_618_000 },
    pacFallbackKwh: 1100,            // operator's PAC integration
  });
  assert.equal(r.etotalKwh, 1100);
  assert.equal(r.parceKwh,  1100);
  assert.equal(r.provenance, "pac_fallback");
});

test("PAC fallback: respects pacFallbackEnabled=false (revert to NaN)", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: { source: "poll_late", etotal_baseline: 0, parce_baseline: 0 },
    curCounter: { etotal_kwh: 100, parce_kwh: 100 },
    pacFallbackKwh: 50,
    pacFallbackEnabled: false,
  });
  assert.ok(Number.isNaN(r.etotalKwh));
  assert.ok(Number.isNaN(r.parceKwh));
  assert.equal(r.provenance, "missing");
});

test("PAC fallback: rejects implausible PAC (> ceiling) — falls through to NaN", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: { source: "poll_late", etotal_baseline: 0, parce_baseline: 0 },
    curCounter: { etotal_kwh: 100, parce_kwh: 100 },
    pacFallbackKwh: 99_999,          // way above 9000 kWh ceiling
  });
  assert.ok(Number.isNaN(r.etotalKwh));
  assert.equal(r.provenance, "missing");
});

test("PAC fallback: past-day with no baseline at all → fills from PAC", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const r = computeHwDeltasForUnitDay({
    day: "2026-05-10", today: "2026-05-11",
    baseline: null,
    pacFallbackKwh: 850,
  });
  assert.equal(r.etotalKwh, 850);
  assert.equal(r.parceKwh,  850);
  assert.equal(r.provenance, "pac_fallback");
});

test("Normal HW path is preferred over PAC fallback when baseline is healthy", () => {
  const { computeHwDeltasForUnitDay } = require("../hwCounterDeltaCore");
  const today = "2026-05-11";
  const r = computeHwDeltasForUnitDay({
    day: today, today,
    baseline: { etotal_baseline: 100_000, parce_baseline: 50_000, source: "eod_clean" },
    curCounter: { etotal_kwh: 100_500, parce_kwh: 50_400 },
    pacFallbackKwh: 999,    // would-be fallback ignored
  });
  assert.equal(r.etotalKwh, 500);     // real HW Δ wins
  assert.equal(r.parceKwh,  400);
  assert.equal(r.provenance, "hw_counter");
});
