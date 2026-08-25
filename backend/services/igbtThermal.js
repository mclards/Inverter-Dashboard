"use strict";

/**
 * IGBT Health Phase 2.1 — thermal-baseline pure functions.
 *
 * All exports are deterministic, side-effect-free, and operate on plain
 * objects/arrays. No DB access, no I/O, no clock reads — every clock-like
 * input is passed in explicitly.
 *
 * Sources:
 *   • Manual §5.2 (matched-conditions monthly thermal baseline)
 *   • Manual §6.5 (thermal_score = clamp(yoy_drift × 12, 0..100))
 *   • plans/igbt-health-phase1.md §5 (Phase 1 weights — preserved when YoY null)
 *
 * Design constraints (locked 2026-05-10 with operator):
 *   • Match-condition window is midday slots 132–167 (11:00–13:55 local).
 *     Slot 168 (14:00) is the start of the post-window block and is excluded
 *     so noon's 3 hours of high-irradiance steady operation are isolated
 *     from afternoon thermal recovery.
 *   • Power band 60 % – 85 % of nominal (manual §5.2). Inclusive at both ends.
 *   • Need ≥ 6 valid samples (30 min sustained) before persisting a value.
 *   • Days containing any aging-relevant stop event (FRAMA / TEMPERATURA /
 *     PI_ANA — see motiveLabelsStd.js / igbtHealth aggregation) are excluded
 *     so the baseline reflects normal-operation thermals, not faulted runs.
 *   • Ambient temperature filter from the manual is **NOT** applied yet — we
 *     don't currently capture ambient on this site. Document this limitation
 *     so future work knows what's missing.
 *   • Year-over-year window is 365 days (one full annual cycle). Less than
 *     365 days of computed history → baseline_ready=false, score component
 *     contributes 0 (caller renormalizes).
 */

const MIDDAY_SLOT_START = 132;   // 11:00 local
const MIDDAY_SLOT_END_EXCL = 168; // 14:00 local (exclusive)
const POWER_BAND_LO_PCT = 0.60;
const POWER_BAND_HI_PCT = 0.85;
const MIN_SAMPLES = 6;            // 30 min sustained
const DEFAULT_BASELINE_TARGET_DAYS = 365;
const DRIFT_TO_SCORE_MULT = 12;   // manual §6.5

/**
 * computeDailyBaseline(rows, ratedKw, opts?)
 *
 * @param {Array<{slot_index:number,pac_w:number,temp_c:number}>} rows
 *   5-min rows for ONE (inverter_ip, slave, date_local) bucket.
 * @param {number} ratedKw  Per-node rated power in kW (from ipconfig).
 * @param {Object} [opts]
 * @param {boolean} [opts.excludeDay=false]  If true, the day contained an
 *   aging-relevant stop event and the baseline must be skipped entirely.
 * @returns {{ sample_count:number, mean_temp_c:number|null, reason:string }}
 *   reason is one of: "computed", "insufficient_samples", "no_data",
 *   "no_rated_kw", "excluded_stop_event".
 */
function computeDailyBaseline(rows, ratedKw, opts) {
  const { excludeDay = false } = opts || {};
  if (excludeDay) {
    return { sample_count: 0, mean_temp_c: null, reason: "excluded_stop_event" };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { sample_count: 0, mean_temp_c: null, reason: "no_data" };
  }
  const ratedW = Number(ratedKw) * 1000;
  if (!Number.isFinite(ratedW) || ratedW <= 0) {
    return { sample_count: 0, mean_temp_c: null, reason: "no_rated_kw" };
  }
  const loW = ratedW * POWER_BAND_LO_PCT;
  const hiW = ratedW * POWER_BAND_HI_PCT;

  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    const slot = Number(r.slot_index);
    if (!Number.isFinite(slot) || slot < MIDDAY_SLOT_START || slot >= MIDDAY_SLOT_END_EXCL) continue;
    const pac = Number(r.pac_w);
    if (!Number.isFinite(pac) || pac < loW || pac > hiW) continue;
    const t = Number(r.temp_c);
    if (!Number.isFinite(t) || t <= 0) continue;
    sum += t;
    n += 1;
  }

  if (n < MIN_SAMPLES) {
    return { sample_count: n, mean_temp_c: null, reason: "insufficient_samples" };
  }
  const mean = Math.round((sum / n) * 100) / 100;
  return { sample_count: n, mean_temp_c: mean, reason: "computed" };
}

/**
 * aggregateMeanTemp(baselineRows)
 * Mean of `mean_temp_c` over rows where reason='computed'. Null if no
 * usable rows.
 *
 * @param {Array<{mean_temp_c:number|null, reason:string}>} baselineRows
 * @returns {number|null}
 */
function aggregateMeanTemp(baselineRows) {
  if (!Array.isArray(baselineRows) || baselineRows.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const r of baselineRows) {
    if (!r || r.reason !== "computed") continue;
    const v = Number(r.mean_temp_c);
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  if (n === 0) return null;
  return Math.round((sum / n) * 100) / 100;
}

/**
 * computeYoYDrift(currentMean, priorYearMean)
 * Returns drift in °C (current minus prior). Null if either input null.
 */
function computeYoYDrift(currentMean, priorYearMean) {
  if (currentMean == null || priorYearMean == null) return null;
  const c = Number(currentMean);
  const p = Number(priorYearMean);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
  return Math.round((c - p) * 100) / 100;
}

/**
 * thermalDriftScore(yoy_drift_c)
 * Per manual §6.5: score = clamp(drift × 12, 0, 100).
 * Negative drift (cooler over time) contributes 0 — it's not aging.
 */
function thermalDriftScore(yoy_drift_c) {
  if (yoy_drift_c == null) return null;
  const d = Number(yoy_drift_c);
  if (!Number.isFinite(d)) return null;
  if (d <= 0) return 0;
  return Math.min(100, d * DRIFT_TO_SCORE_MULT);
}

/**
 * baselineProgress(computedDays, targetDays?)
 * Reports how close the baseline is to YoY-ready. Until ratio >= 1, callers
 * should treat the YoY component as null and renormalize the health score.
 */
function baselineProgress(computedDays, targetDays) {
  const target = Number(targetDays || DEFAULT_BASELINE_TARGET_DAYS);
  const days = Number(computedDays);
  if (!Number.isFinite(days) || days < 0) {
    return { ready: false, ratio: 0, computed_days: 0, target_days: target };
  }
  const ratio = Math.min(1, days / target);
  return {
    ready: ratio >= 1,
    ratio,
    computed_days: Math.floor(days),
    target_days: target,
  };
}

module.exports = {
  computeDailyBaseline,
  aggregateMeanTemp,
  computeYoYDrift,
  thermalDriftScore,
  baselineProgress,
  // exposed for test/diagnostic
  MIDDAY_SLOT_START,
  MIDDAY_SLOT_END_EXCL,
  POWER_BAND_LO_PCT,
  POWER_BAND_HI_PCT,
  MIN_SAMPLES,
  DEFAULT_BASELINE_TARGET_DAYS,
  DRIFT_TO_SCORE_MULT,
};
