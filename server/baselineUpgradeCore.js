"use strict";

// Pure-function core for the v2.10.x retroactive baseline upgrade logic.
//
// Background:
//   When a gateway boots fresh after midnight (or after extended downtime
//   that crossed the dark window), the first poll of the day creates today's
//   inverter_counter_baseline row with `source='poll'` because yesterday's
//   eod_clean snapshot was unavailable at that moment. Without intervention,
//   today's row is locked to 'poll' for the entire day even when later
//   dark-window captures successfully populate yesterday's eod_clean.
//
//   This module decides whether today's row qualifies for a retroactive
//   upgrade from `source='poll'` to `source='eod_clean'` once yesterday's
//   eod_clean lands. The decision is pure-function so the SQL-driving
//   wrapper in db.js can be exercised by regression tests without spinning
//   up SQLite.
//
// Trust ladder for the `source` column:
//   eod_clean       — today's baseline anchored on yesterday's clean close
//                     (best — captured during dark-window pre-dawn polls)
//   eod_clean_only  — late-created row: dark-window capture filled in
//                     eod_clean but the morning baseline was never recorded
//                     (gateway was off when the day started). Same-day Δ for
//                     this row is unknown; the row exists only so the NEXT
//                     day can use eod_clean as its anchor.
//   poll            — today's baseline came from the first poll of the day;
//                     yesterday's eod_clean was unavailable at insert time.
//                     Etotal Δ undercounts by whatever the inverter produced
//                     before the first poll fired.
//   pac_seed        — reserved for future use (v2.9.0 design left the slot
//                     for a recovery-seeded baseline; not currently written
//                     by any code path).

const SOURCE_EOD_CLEAN      = "eod_clean";
const SOURCE_EOD_CLEAN_ONLY = "eod_clean_only";
const SOURCE_POLL           = "poll";
const SOURCE_PAC_SEED       = "pac_seed";

// shouldUpgradeBaselineToEodClean
//
// Returns true when today's `source='poll'` row should be rewritten to
// `source='eod_clean'` using yesterday's eod_clean as the new anchor.
//
// All four guards must pass for the upgrade to fire — same as the original
// first-poll baseline-creation gate in db.js (line ~2491). Keeping the
// logic identical means a row created on first-poll-with-yesterday-clean is
// indistinguishable from a row that was 'poll' first and got upgraded.
//
// Inputs:
//   todayRow         — { source, etotal_baseline, parce_baseline, ... } | null
//   yesterdayRow     — { etotal_eod_clean, parce_eod_clean,
//                        eod_clean_ts_ms, ... }                          | null
//   currentEtotalKwh — current frame's etotal_kwh (for monotonicity check)
//
// Output:
//   {
//     upgrade: boolean,
//     reason:  short string explaining why (or why not) for audit logs,
//     newBaseline: { etotal, parce, ts_ms } | null,
//   }

function shouldUpgradeBaselineToEodClean({
  todayRow = null,
  yesterdayRow = null,
  currentEtotalKwh = NaN,
} = {}) {
  if (!todayRow) {
    return { upgrade: false, reason: "no today row", newBaseline: null };
  }
  const todaySource = String(todayRow.source || "").toLowerCase();
  if (todaySource !== SOURCE_POLL) {
    return {
      upgrade: false,
      reason: `today source is '${todaySource}', not 'poll'`,
      newBaseline: null,
    };
  }
  if (!yesterdayRow) {
    return { upgrade: false, reason: "no yesterday row", newBaseline: null };
  }

  const yEtotal = Number(yesterdayRow.etotal_eod_clean || 0);
  const yParce  = Number(yesterdayRow.parce_eod_clean  || 0);
  const yTs     = Number(yesterdayRow.eod_clean_ts_ms  || 0);
  const cur     = Number(currentEtotalKwh);

  if (!(yEtotal > 0)) {
    return { upgrade: false, reason: "yesterday eod_clean missing", newBaseline: null };
  }
  if (!(yTs > 0)) {
    return { upgrade: false, reason: "yesterday eod_clean ts missing", newBaseline: null };
  }
  if (!Number.isFinite(cur) || cur <= 0) {
    return { upgrade: false, reason: "current etotal invalid", newBaseline: null };
  }
  if (yEtotal > cur) {
    // Yesterday's close is GREATER than today's current reading — would be
    // a counter regression. Refuse to anchor; something is wrong upstream.
    return {
      upgrade: false,
      reason: `yesterday eod_clean (${yEtotal}) > current etotal (${cur})`,
      newBaseline: null,
    };
  }

  return {
    upgrade: true,
    reason: "yesterday eod_clean available; upgrading today poll → eod_clean",
    newBaseline: {
      etotal: yEtotal,
      parce:  yParce,
      ts_ms:  yTs,
    },
  };
}

module.exports = {
  SOURCE_EOD_CLEAN,
  SOURCE_EOD_CLEAN_ONLY,
  SOURCE_POLL,
  SOURCE_PAC_SEED,
  shouldUpgradeBaselineToEodClean,
};
