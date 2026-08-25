"use strict";

// Pure decision core for the daily Etotal/parcE baseline anchor.
//
// Background — when persistCounterState() sees the first frame of a new day
// for a given (inverter, unit), it must record a "baseline" (etotal + parce
// values at start-of-day) so the export can compute the day's HW delta as
// `eod_clean − baseline`. The export's slow/fast path then renders that
// delta as the Etotal_MWh and ParcE_MWh columns.
//
// The legacy decision (server/db.js v2.10.x) was:
//
//   if yesterday.eod_clean exists → anchor on yesterday's clean snapshot
//                                   (source = "eod_clean")
//   else → anchor on the first poll's etotal_kwh (source = "poll")
//
// The "poll" fallback under-counts whenever the gateway boots after sunrise
// and the inverter has already produced kWh that morning. Operator screenshot
// 2026-05-11 showed Inv 12 Node 3 with PAC 1.10 MWh vs Etotal Δ 0.574 MWh —
// ≈ 47 % gap explained by an ~3-4 h late baseline.
//
// New rule: when no `eod_clean` snapshot exists AND the inverter is observed
// already producing power (PAC > a small threshold), refuse to anchor on the
// late poll. Instead, write the row with source = "poll_late" — a sentinel
// that hwCounterDeltaCore.computeHwDeltasForUnitDay() treats as NaN-
// propagating, so the export shows blank HW columns rather than a
// misleading undercount. The operator's Status column (the ACTIVE /
// BASELINE_LATE classifier) then surfaces the situation explicitly.
//
// Why NaN-propagate instead of "best-effort poll baseline"?
//   • Operators trust HW counters as the authoritative day total. A wrong
//     number is more harmful than a missing one.
//   • Exporter's Total_MWh column (PAC integration) still renders the day's
//     production correctly — operators get a number, just from the right
//     source.
//   • Tomorrow morning, after a clean post-sunset eod_clean snapshot exists,
//     the next-day baseline anchors normally.
//
// Inputs (all numeric — no DB types):
//
//   curEtotalKwh         current Etotal counter reading (kWh)
//   curParceKwh          current parcE counter reading (kWh)
//   curTsMs              timestamp of the first frame this day
//   curPacW              instantaneous PAC at first frame
//   yesterdayEodClean    {
//                          etotal_eod_clean, parce_eod_clean,
//                          eod_clean_ts_ms,
//                        } | null
//   pacWakeThresholdW    operator-tunable; PAC above this means "already
//                        producing" (default 50 W matches db.js eod-clean
//                        wake gate)
//
// Output:
//
//   {
//     source:           "eod_clean" | "poll" | "poll_late",
//     etotalBaseline:   number,
//     parceBaseline:    number,
//     baselineTsMs:     number,
//     reason:           short explanation for audit log,
//   }

const DEFAULT_PAC_WAKE_THRESHOLD_W = 50;

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _isPositive(v) {
  const n = _toFiniteNumber(v);
  return Number.isFinite(n) && n > 0;
}

function decideBaselineAnchor({
  curEtotalKwh,
  curParceKwh,
  curTsMs,
  curPacW,
  yesterdayEodClean = null,
  pacWakeThresholdW = DEFAULT_PAC_WAKE_THRESHOLD_W,
} = {}) {
  const curE = _toFiniteNumber(curEtotalKwh);
  const curP = _toFiniteNumber(curParceKwh);
  const curTs = _toFiniteNumber(curTsMs);
  const curPac = _toFiniteNumber(curPacW);
  const wakeW = _isPositive(pacWakeThresholdW)
    ? Number(pacWakeThresholdW)
    : DEFAULT_PAC_WAKE_THRESHOLD_W;

  // Guard: caller should never have invoked us without sane inputs, but be
  // defensive — return a "poll_late"-equivalent so the export stays blank.
  if (!Number.isFinite(curE) || !Number.isFinite(curTs)) {
    return {
      source: "poll_late",
      etotalBaseline: 0,
      parceBaseline: 0,
      baselineTsMs: Number.isFinite(curTs) ? curTs : 0,
      reason: "invalid_inputs",
    };
  }

  // Path 1: yesterday's eod_clean snapshot is the gold-standard anchor.
  const yE = _toFiniteNumber(yesterdayEodClean?.etotal_eod_clean);
  const yP = _toFiniteNumber(yesterdayEodClean?.parce_eod_clean);
  const yTs = _toFiniteNumber(yesterdayEodClean?.eod_clean_ts_ms);
  const eodUsable = Number.isFinite(yE) && yE > 0
    && Number.isFinite(yTs) && yTs > 0
    && yE <= curE;   // monotonic check — clean snapshot must precede today
  if (eodUsable) {
    return {
      source: "eod_clean",
      etotalBaseline: yE,
      parceBaseline: Number.isFinite(yP) ? yP : 0,
      baselineTsMs: yTs,
      reason: "yesterday_eod_clean",
    };
  }

  // Path 2: no clean anchor available. If the inverter is already producing
  // power at first observation, anchoring on the current Etotal would
  // under-count today's Δ. Mark the row poll_late so the export blanks the
  // HW column.
  if (Number.isFinite(curPac) && curPac > wakeW) {
    return {
      source: "poll_late",
      etotalBaseline: curE,           // record what we saw, but the source
      parceBaseline: Number.isFinite(curP) ? curP : 0,
      baselineTsMs: curTs,
      reason: `pac=${Math.round(curPac)}W>threshold=${wakeW}W and no yesterday eod_clean`,
    };
  }

  // Path 3: cold start (gateway booted before sunrise OR inverter is idle).
  // Use the first-poll value as the baseline — it's accurate.
  return {
    source: "poll",
    etotalBaseline: curE,
    parceBaseline: Number.isFinite(curP) ? curP : 0,
    baselineTsMs: curTs,
    reason: "cold_start_first_poll",
  };
}

module.exports = {
  DEFAULT_PAC_WAKE_THRESHOLD_W,
  decideBaselineAnchor,
};
