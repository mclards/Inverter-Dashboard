"use strict";

// Pure classifier for Energy Summary node-row status + PAC↔HW discrepancy.
//
// Background — the Energy Summary export emits one row per (date, inverter,
// unit). Each row carries:
//   • First_Seen / Last_Seen  — derived from persisted readings
//   • Peak_Pac_kW            — max PAC observed during the day
//   • Total_MWh              — PAC trapezoidal integration (energy_5min-anchored)
//   • Etotal_MWh, ParcE_MWh  — hardware-counter delta (eod_clean − baseline)
//
// In production we observed two confusing operator-facing artefacts:
//   1. Rows where 1st_Seen / Last_Seen are populated but every numeric column
//      is 0. Cause: the inverter briefly responded to Modbus (a few minutes)
//      but produced no power. The poller's no-change skip persists only the
//      first frame and any state-change frame, so the row exists but carries
//      no real data. Operators read the populated timestamps as "logged" and
//      the zeros as "data lost", when in fact the inverter was idle.
//   2. Rows where the PAC integral and HW counter delta disagree by 30–50%.
//      Cause: today's baseline anchored on the first morning poll (when the
//      gateway booted after sunrise and yesterday's eod_clean snapshot was
//      missing), so the morning kWh is missing from the HW delta.
//
// This classifier returns a short status code + a relative discrepancy
// percentage so the export can surface the ground truth without dropping
// rows. The thresholds are tunable; the defaults are conservative so a
// healthy node always classifies ACTIVE.
//
// Status codes (priority order — first match wins):
//   NO_DATA            — sample_count == 0 (should not normally appear)
//   BRIEF_RESPONSE     — window < BRIEF_WINDOW_MIN minutes AND peak_pac == 0
//                        (likely Modbus comm artefact / aborted inverter restart)
//   ZERO_PRODUCTION    — window ≥ BRIEF_WINDOW_MIN minutes AND peak_pac == 0
//                        (inverter was online but never exported power)
//   ESTIMATED_FROM_PAC — HW delta columns were filled from the PAC integral
//                        because the morning baseline anchor was unreliable
//                        (source='poll_late' or 'eod_clean_only', or
//                        baseline missing entirely). The PAC-based MWh
//                        column is independent of HW counters and remains
//                        authoritative; the HW columns are repeated from
//                        it so the operator sees a number plus this flag.
//   BASELINE_LATE      — Etotal HW delta < (1 - DISCREPANCY_PCT) x PAC
//                        integral (HW counter under-counts; the daily
//                        baseline was anchored after production already
//                        started but not severe enough to trip the
//                        poll_late guard upstream — e.g. operator opted
//                        out of the PAC fallback)
//   HW_OVER            — Etotal HW delta > (1 + DISCREPANCY_PCT) x PAC
//                        integral (PAC integral missed time; counter is
//                        the source of truth)
//
// Operator-facing `reason` text is intentionally plain ASCII words only
// (no delta / less-than-or-equal / trailing-question-mark glyphs) so the
// exported Energy Summary "Notes" column is unambiguous on every locale and
// codepage. energySummaryNodeStatusCore.test.js enforces this with a
// no-symbol guard.
//   ACTIVE             — fall-through; everything healthy
//
// Inputs are kWh-equivalent / W / ms — no units conversion done here.

const BRIEF_WINDOW_MIN_DEFAULT = 30;
const DISCREPANCY_PCT_DEFAULT  = 0.20;
const PEAK_PAC_NOISE_W         = 100;     // ≤ 100 W peak counts as "no production"

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _windowMinutes(firstTsMs, lastTsMs) {
  const a = Number(firstTsMs || 0);
  const b = Number(lastTsMs || 0);
  if (!(a > 0) || !(b > 0) || b < a) return 0;
  return (b - a) / 60000;
}

// classifyEnergySummaryNode
//
// Input shape:
//   {
//     sampleCount?,          // optional — defaults to "unknown / >0"
//     firstTsMs, lastTsMs,
//     pacPeakW,
//     pacKwh,                // PAC trapezoidal integration (kWh)
//     etotalDeltaKwh,        // HW Etotal day delta (kWh) — NaN if not computed
//     parceDeltaKwh,         // HW parcE day delta (kWh)  — NaN if not computed
//     hwProvenance?,         // 'hw_counter' | 'pac_fallback' | 'missing'
//                            // (from hwCounterDeltaCore.computeHwDeltasForUnitDay)
//   }
//
// Options:
//   briefWindowMin   — minutes; default 30
//   discrepancyPct   — fraction; default 0.20 (= ±20 %)
//
// Output:
//   {
//     status:        one of { NO_DATA, BRIEF_RESPONSE, ZERO_PRODUCTION,
//                             BASELINE_LATE, HW_OVER, ACTIVE },
//     reason:        short human-readable string,
//     deltaPct:      signed (HW - PAC) / PAC * 100, or NaN if no comparison,
//     windowMinutes: window length in minutes (0 if missing),
//   }
function classifyEnergySummaryNode(input = {}, options = {}) {
  const briefMin = Number.isFinite(Number(options.briefWindowMin))
    ? Number(options.briefWindowMin) : BRIEF_WINDOW_MIN_DEFAULT;
  const discPct = Number.isFinite(Number(options.discrepancyPct))
    ? Number(options.discrepancyPct) : DISCREPANCY_PCT_DEFAULT;

  const sampleCount = input.sampleCount == null
    ? null
    : Math.max(0, Math.trunc(Number(input.sampleCount) || 0));
  const peakW = Math.max(0, Number(input.pacPeakW || 0));
  const pacKwh = Math.max(0, Number(input.pacKwh || 0));
  const etotalKwh = _toFiniteNumber(input.etotalDeltaKwh);
  const parceKwh  = _toFiniteNumber(input.parceDeltaKwh);
  const winMin = _windowMinutes(input.firstTsMs, input.lastTsMs);

  // Discrepancy is only meaningful when BOTH sides are non-trivial. Use the
  // Etotal delta when present, parcE as backup. Reported as signed pct of PAC.
  let deltaPct = NaN;
  if (pacKwh > 0.05) {
    const hw = Number.isFinite(etotalKwh) && etotalKwh > 0
      ? etotalKwh
      : (Number.isFinite(parceKwh) ? parceKwh : NaN);
    if (Number.isFinite(hw)) {
      deltaPct = ((hw - pacKwh) / pacKwh) * 100;
    }
  }

  // ── Status priority ────────────────────────────────────────────────────
  if (sampleCount === 0) {
    return { status: "NO_DATA", reason: "no samples persisted", deltaPct, windowMinutes: winMin };
  }

  if (peakW <= PEAK_PAC_NOISE_W && pacKwh <= 0.001) {
    if (winMin > 0 && winMin < briefMin) {
      return {
        status: "BRIEF_RESPONSE",
        reason: `Modbus comm window ${winMin.toFixed(1)} min, no PAC observed`,
        deltaPct, windowMinutes: winMin,
      };
    }
    return {
      status: "ZERO_PRODUCTION",
      reason: winMin > 0
        ? `${winMin.toFixed(1)} min online, peak PAC at or below ${PEAK_PAC_NOISE_W} W`
        : "no PAC observed",
      deltaPct, windowMinutes: winMin,
    };
  }

  // The HW Δ columns were filled from the PAC integral (because the morning
  // baseline was unreliable). Surface this so the operator knows the HW
  // columns are not independent measurements for this row.
  const provenance = String(input.hwProvenance || "").toLowerCase();
  if (provenance === "pac_fallback") {
    return {
      status: "ESTIMATED_FROM_PAC",
      reason:
        "Hardware Etotal and parcE columns were filled from the PAC-integrated " +
        "energy because the daily baseline anchor was unreliable. These two " +
        "columns are NOT independent measurements for this row; the " +
        "PAC-integrated total is the authoritative day energy.",
      deltaPct, windowMinutes: winMin,
    };
  }

  // Production happened — only flag discrepancy when we have a real comparison.
  if (Number.isFinite(deltaPct)) {
    const thresholdPct = discPct * 100;
    if (deltaPct < -thresholdPct) {
      return {
        status: "BASELINE_LATE",
        reason:
          `Hardware Etotal day delta is lower than the PAC-integrated energy ` +
          `by ${Math.abs(deltaPct).toFixed(1)} percent. Cause: the daily ` +
          `baseline was anchored after production had already started ` +
          `(the gateway started after sunrise with no prior clean ` +
          `end-of-day snapshot), so the early-morning energy is missing from ` +
          `the hardware-counter delta. The PAC-integrated total on this row ` +
          `remains the authoritative day energy.`,
        deltaPct, windowMinutes: winMin,
      };
    }
    if (deltaPct > thresholdPct) {
      return {
        status: "HW_OVER",
        reason:
          `Hardware Etotal day delta is higher than the PAC-integrated ` +
          `energy by ${deltaPct.toFixed(1)} percent. Cause: PAC integration ` +
          `missed polling time (communication gaps), so the hardware ` +
          `counter is the more complete day total for this row.`,
        deltaPct, windowMinutes: winMin,
      };
    }
  }

  return { status: "ACTIVE", reason: "ok", deltaPct, windowMinutes: winMin };
}

module.exports = {
  BRIEF_WINDOW_MIN_DEFAULT,
  DISCREPANCY_PCT_DEFAULT,
  PEAK_PAC_NOISE_W,
  classifyEnergySummaryNode,
};
