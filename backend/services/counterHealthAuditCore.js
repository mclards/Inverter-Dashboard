"use strict";

// Pure decision core for counter-health audit emission.
//
// Rules — kept narrow because every poll cycle invokes this, and we cannot
// flood the audit log under a sustained anomaly:
//
//   1. ETOTAL_REGRESSED — fires when the latest etotal_kwh is strictly less
//      than the previous sample (lifetime kWh should never decrease).
//      Causes: firmware swap, partial-frame decode, hardware fault, counter
//      wrap (4.29 GWh — physically irrelevant for any real PV deployment).
//
//   2. COUNTER_STUCK — fires on a 1→0 transition in counter_advancing
//      (computed by evaluateCounterAdvancing in db.js): the unit is
//      producing PAC > 500 W mean over a 5-min window but Etotal hasn't
//      ticked. The HW Δ for the day will under-count until cleared.
//      Recovery (0→1 transition) clears the dedup so a fresh stall re-fires.
//
// Both audits dedup at most once per (inverter, unit, action) per
// `dedupMs` window (default 1 hour). The dedup map is owned by the caller
// so the pure function stays stateless and testable.
//
// This module deliberately does NOT touch SQLite or call insertAuditLogRow.
// The caller (server/db.js → persistCounterState) translates the returned
// `audits` into actual log rows.

const DEFAULT_DEDUP_MS = 60 * 60 * 1000;

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// decideCounterHealthAudits
//
// Inputs:
//   inverter, unit               number identifiers (used to construct dedup keys)
//   history                      array of {ts_ms, etotal_kwh, parce_kwh, pac_w}
//                                with the latest sample appended last. Must
//                                hold at least 2 entries for any audit to fire.
//   counterAdvancing             0|1 — current frame's counter_advancing flag
//                                (caller computes it via evaluateCounterAdvancing)
//   prevCounterAdvancing         0|1|undefined — last frame's value for the
//                                same (inverter, unit). Pass `undefined` on
//                                cold start.
//   lastAuditAtByKey             Map<dedupKey, ts_ms> — most-recent audit
//                                emit time per dedup key. Mutated by this
//                                function.
//   nowMs                        timestamp to compare against dedupMs.
//   dedupMs                      window between dedup'd repeats (default 1h).
//
// Output:
//   {
//     audits: [
//       {action: 'etotal_regressed' | 'counter_stuck', reason: string,
//        consoleMessage: string, dedupKey: string},
//     ],
//     nextCounterAdvancing: 0|1,
//   }

function decideCounterHealthAudits({
  inverter,
  unit,
  history = [],
  counterAdvancing,
  prevCounterAdvancing,
  lastAuditAtByKey,
  nowMs,
  dedupMs = DEFAULT_DEDUP_MS,
} = {}) {
  const out = { audits: [], nextCounterAdvancing: undefined };
  if (!Array.isArray(history) || history.length < 2) {
    out.nextCounterAdvancing =
      Number(counterAdvancing) === 1 ? 1 :
      Number(counterAdvancing) === 0 ? 0 :
      prevCounterAdvancing;
    return out;
  }
  const key = `${inverter}_${unit}`;
  const latest = history[history.length - 1] || {};
  const prev = history[history.length - 2] || {};
  const now = _toFiniteNumber(nowMs);
  const win = _toFiniteNumber(dedupMs);
  const dedup = lastAuditAtByKey instanceof Map ? lastAuditAtByKey : null;

  const _emitOk = (dedupKey) => {
    if (!dedup) return true;
    const last = Number(dedup.get(dedupKey) || 0);
    if (!last) return true;
    if (!Number.isFinite(now) || !Number.isFinite(win)) return true;
    return (now - last) >= win;
  };

  const _markEmitted = (dedupKey) => {
    if (dedup && Number.isFinite(now)) dedup.set(dedupKey, now);
  };

  // (1) Etotal monotonicity guard
  const eNow = _toFiniteNumber(latest.etotal_kwh);
  const ePrev = _toFiniteNumber(prev.etotal_kwh);
  if (Number.isFinite(eNow) && Number.isFinite(ePrev) && eNow > 0 && ePrev > 0 && eNow < ePrev) {
    const dedupKey = `${key}_etotal_regressed`;
    if (_emitOk(dedupKey)) {
      const dropKwh = ePrev - eNow;
      out.audits.push({
        action: "etotal_regressed",
        reason: `Etotal ${ePrev} → ${eNow} kWh (drop ${dropKwh})`,
        consoleMessage:
          `[counter-health] inv=${inverter}/${unit} Etotal REGRESSED ` +
          `${ePrev} → ${eNow} kWh (drop ${dropKwh} kWh) — possible firmware ` +
          `swap, partial frame, or hardware fault`,
        dedupKey,
      });
      _markEmitted(dedupKey);
    }
  }

  // (2) Stuck counter — flip 1→0 transition
  const wasAdvancing = Number(prevCounterAdvancing);
  const isAdvancing = Number(counterAdvancing) === 1 ? 1 : 0;
  if (wasAdvancing === 1 && isAdvancing === 0) {
    const dedupKey = `${key}_counter_stuck`;
    if (_emitOk(dedupKey)) {
      const meanPac = Math.round(
        history.reduce((s, r) => s + (_toFiniteNumber(r?.pac_w) || 0), 0) / history.length,
      );
      out.audits.push({
        action: "counter_stuck",
        reason: `Etotal frozen with mean PAC ≈ ${meanPac} W over last ${history.length} samples`,
        consoleMessage:
          `[counter-health] inv=${inverter}/${unit} STUCK counter — Etotal ` +
          `not advancing while mean PAC ≈ ${meanPac} W. HW Δ for this unit ` +
          `will under-count today.`,
        dedupKey,
      });
      _markEmitted(dedupKey);
    }
  } else if (wasAdvancing === 0 && isAdvancing === 1) {
    // Recovery — clear the dedup so a fresh stall re-fires.
    if (dedup) dedup.delete(`${key}_counter_stuck`);
  }

  out.nextCounterAdvancing = isAdvancing;
  return out;
}

module.exports = {
  DEFAULT_DEDUP_MS,
  decideCounterHealthAudits,
};
