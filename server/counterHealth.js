"use strict";

/**
 * v2.9.0 Slice F — Hardware counter health gates (Node mirror of Python impl).
 *
 * Pure functions used by:
 *   • /api/counter-state/all   — augment rows with counter_advancing / trust flags
 *   • server/exporter.js       — decide quarantine + Counter_Source per export row
 *   • admin UI JS              — derive per-unit status badge
 *
 * Python mirror lives in services/inverter_engine.py (identical semantics).
 */

/**
 * True when the last observed RTC year is within ±1 of the server year.
 * Accepts a counter_state row shape: { rtc_valid, rtc_ms }.
 */
function rtcYearValid(state, serverNow = new Date()) {
  if (!state) return false;
  if (!state.rtc_valid) return false;
  const rtcMs = Number(state.rtc_ms);
  if (!Number.isFinite(rtcMs) || rtcMs <= 0) return false;
  const rtcYear = new Date(rtcMs).getFullYear();
  return Math.abs(rtcYear - serverNow.getFullYear()) <= 1;
}

/**
 * True when the counter is either advancing or the unit is idle (mean PAC < threshold).
 * `history` is ordered oldest→newest; each sample has {ts_ms, etotal_kwh, pac_w}.
 */
function counterAdvancing(history, windowS = 300, pacIdleW = 500) {
  if (!Array.isArray(history) || history.length < 2) return true; // insufficient data
  const latest = history[history.length - 1];
  const cutoff = Number(latest.ts_ms || 0) - windowS * 1000;
  const recent = history.filter((r) => Number(r.ts_ms || 0) >= cutoff);
  if (recent.length < 2) return true;
  const meanPac =
    recent.reduce((s, r) => s + Number(r.pac_w || 0), 0) / recent.length;
  if (meanPac < pacIdleW) return true;
  for (let i = 1; i < recent.length; i++) {
    if (Number(recent[i].etotal_kwh || 0) > Number(recent[i - 1].etotal_kwh || 0)) {
      return true;
    }
  }
  return false;
}

/**
 * True when parcE delta over the window tracks PAC integration at kWh/kWh ratio.
 * Returns true if insufficient data or PAC is too small to evaluate.
 */
function parcePrecisionOk(history, pacIntegratedWh, windowS = 300) {
  if (!Array.isArray(history) || history.length < 2) return true;
  if (!Number.isFinite(Number(pacIntegratedWh)) || Number(pacIntegratedWh) <= 0) return true;
  const first = history[0];
  const last = history[history.length - 1];
  const dp = Number(last.parce_kwh || 0) - Number(first.parce_kwh || 0);
  if (dp <= 0) return false;
  const ratio = dp / Number(pacIntegratedWh);
  return ratio >= 0.00050 && ratio <= 0.01100;
}

/**
 * trust_etotal — safe to use Etotal for reconciliation / recovery.
 */
function trustEtotal(state, history, serverNow = new Date()) {
  return Boolean(rtcYearValid(state, serverNow) && counterAdvancing(history));
}

/**
 * trust_parce — safe to use parcE for reconciliation / recovery.
 */
function trustParce(state, history, pacIntegratedWh, serverNow = new Date()) {
  return Boolean(
    rtcYearValid(state, serverNow) &&
      counterAdvancing(history) &&
      parcePrecisionOk(history, pacIntegratedWh),
  );
}

/**
 * Classify a counter row for export: { source, quarantined, reason }.
 * source ∈ 'pac_integrated' | 'etotal_recovered' | 'parce_recovered' | 'mixed' | 'quarantined'
 */
function classifyCounter(state, history, pacIntegratedWh, serverNow = new Date()) {
  if (!state) {
    return { source: "pac_integrated", quarantined: 0, reason: "no_counter_state" };
  }
  const ry = rtcYearValid(state, serverNow);
  if (!ry) {
    return { source: "quarantined", quarantined: 1, reason: "rtc_invalid" };
  }
  const adv = counterAdvancing(history);
  if (!adv) {
    return { source: "quarantined", quarantined: 1, reason: "counter_frozen" };
  }
  const prec = parcePrecisionOk(history, pacIntegratedWh);
  if (!prec) {
    // Advances + RTC OK, parcE precision off — still usable for Etotal path.
    return { source: "etotal_recovered", quarantined: 0, reason: "parce_precision_off" };
  }
  return { source: "pac_integrated", quarantined: 0, reason: "" };
}

module.exports = {
  rtcYearValid,
  counterAdvancing,
  parcePrecisionOk,
  trustEtotal,
  trustParce,
  classifyCounter,
};
