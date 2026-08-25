"use strict";

/**
 * igbtHealth.js — IGBT Health Score Computation (Pure Functions)
 *
 * All functions are deterministic, side-effect-free, and testable in isolation.
 * No database access, no HTTP calls, no timestamps beyond explicit parameters.
 *
 * Related plan: plans/igbt-health-phase1.md §5–§11
 * Related manual: docs/IGBT_Aging_Management_Manual.docx §5–§6
 *
 * Version: v2.11.0 (Phase 1 MVP)
 */

/**
 * computeHealthScore(inputs) → {score, tier, breakdown, weights_used}
 *
 * Composite health score from up to five aging components, weighted and clamped to [0, 100].
 *
 * @param {Object} inputs
 *   @param {number} [inputs.thermal_count=0] — # of thermal stops in rolling window
 *   @param {number} [inputs.frama_count=0]   — # of FRAMA stops in rolling window
 *   @param {number} [inputs.pi_ana_count=0]  — # of PI saturation stops in rolling window
 *   @param {number|null} [inputs.imbalance_pct=null] — phase current imbalance percentage
 *   @param {number|null} [inputs.yoy_drift_c=null]   — year-over-year midday-baseline drift (°C).
 *      When non-null and finite, the score blends a thermal-drift component
 *      using Phase 2 weights. When null (baseline not yet ready), the
 *      Phase 1 weights are used unchanged so scores stay comparable.
 *
 * @returns {Object}
 *   @returns {number} score — composite health score [0, 100], 1 decimal place
 *   @returns {string|null} tier — 'healthy' | 'watch' | 'aging' | 'eol' | null
 *   @returns {Object} breakdown — component scores for audit
 *     @returns {number}      breakdown.thermal_score
 *     @returns {number}      breakdown.frama_score
 *     @returns {number}      breakdown.pi_ana_score
 *     @returns {number}      breakdown.imbal_score
 *     @returns {number|null} breakdown.yoy_score   — null when yoy_drift_c was null
 *   @returns {Object} weights_used — phase indicator + actual weights used
 *     @returns {string}  weights_used.phase  — 'phase1' or 'phase2'
 *     @returns {Object}  weights_used.weights
 *
 * Phase 1 weights (no YoY signal yet — manual §6.5 baseline period):
 *   thermal=0.30, frama=0.30, pi_ana=0.20, imbal=0.20
 *
 * Phase 2 weights (YoY drift available — manual §6.5 mature period):
 *   yoy=0.30, frama=0.25, thermal_trips=0.15, pi_ana=0.15, imbal=0.15
 *
 * Component formulas (unchanged):
 *   - thermal_score = min(100, thermal_count × 25)
 *   - frama_score   = min(100, frama_count × 30)
 *   - pi_ana_score  = min(100, pi_ana_count × 35)
 *   - imbal_score   = min(100, max(0, (imbalance_pct - 1.0) × 20))
 *   - yoy_score     = thermalDriftScore(yoy_drift_c)  // see igbtThermal.js, manual §6.5
 */
function computeHealthScore(inputs = {}) {
  const {
    thermal_count = 0,
    frama_count = 0,
    pi_ana_count = 0,
    imbalance_pct = null,
    yoy_drift_c = null,
  } = inputs;

  // Component scores, each clamped to [0, 100]
  const thermal_score = Math.min(100, Math.max(0, thermal_count * 25));
  const frama_score = Math.min(100, Math.max(0, frama_count * 30));
  const pi_ana_score = Math.min(100, Math.max(0, pi_ana_count * 35));

  let imbal_score = 0;
  if (typeof imbalance_pct === "number" && Number.isFinite(imbalance_pct) && imbalance_pct > 1.0) {
    imbal_score = Math.min(100, (imbalance_pct - 1.0) * 20);
  }

  // YoY drift component: only contributes when caller supplied a finite drift.
  // Uses the manual §6.5 formula: clamp(drift × 12, 0, 100); negative drift → 0.
  const yoyAvailable = typeof yoy_drift_c === "number" && Number.isFinite(yoy_drift_c);
  let yoy_score = null;
  if (yoyAvailable) {
    const d = yoy_drift_c;
    yoy_score = d <= 0 ? 0 : Math.min(100, d * 12);
  }

  let score;
  let weights;
  let phase;
  if (yoyAvailable) {
    weights = { yoy: 0.30, frama: 0.25, thermal_trips: 0.15, pi_ana: 0.15, imbal: 0.15 };
    phase = "phase2";
    score =
      weights.yoy           * yoy_score +
      weights.frama         * frama_score +
      weights.thermal_trips * thermal_score +
      weights.pi_ana        * pi_ana_score +
      weights.imbal         * imbal_score;
  } else {
    weights = { thermal: 0.30, frama: 0.30, pi_ana: 0.20, imbal: 0.20 };
    phase = "phase1";
    score =
      weights.thermal * thermal_score +
      weights.frama   * frama_score +
      weights.pi_ana  * pi_ana_score +
      weights.imbal   * imbal_score;
  }

  const tier = tierForScore(score);

  return {
    score: Math.round(score * 10) / 10,
    tier,
    breakdown: {
      thermal_score: Math.round(thermal_score * 10) / 10,
      frama_score:   Math.round(frama_score * 10) / 10,
      pi_ana_score:  Math.round(pi_ana_score * 10) / 10,
      imbal_score:   Math.round(imbal_score * 10) / 10,
      yoy_score:     yoy_score == null ? null : Math.round(yoy_score * 10) / 10,
    },
    weights_used: { phase, weights },
  };
}

/**
 * tierForScore(score) → 'healthy' | 'watch' | 'aging' | 'eol' | null
 *
 * Classify a health score into one of four tiers.
 * Returns null if score is null/undefined/NaN.
 *
 * Tier boundaries (per plan §5.2 and manual §5):
 *   - Healthy: score < 25     (no significant aging)
 *   - Watch:   25 ≤ score < 50   (early thermal drift, occasional FRAMAs)
 *   - Aging:   50 ≤ score < 75   (frequent stops, high imbalance)
 *   - EOL:     score ≥ 75    (imminent failure indicators)
 *
 * @param {number|null} score
 * @returns {string|null}
 */
function tierForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }

  if (score < 25) return "healthy";
  if (score < 50) return "watch";
  if (score < 75) return "aging";
  return "eol";
}

/**
 * aggregateMotiveCounts(stopReasonRows, motiveCodesArray) → count
 *
 * Count stop-reason rows matching any motive code in the array.
 * Safely handles null/missing motive_code fields.
 *
 * @param {Array|null} stopReasonRows — array of {motive_code, ...}
 * @param {Array|null} motiveCodesArray — array of numeric/string codes to match
 * @returns {number} count of matching rows
 */
function aggregateMotiveCounts(stopReasonRows, motiveCodesArray) {
  if (!Array.isArray(stopReasonRows)) return 0;
  if (!Array.isArray(motiveCodesArray) || motiveCodesArray.length === 0) return 0;

  // Convert all motive codes to numbers for comparison
  const codes = new Set(motiveCodesArray.map(c => Number(c)));

  let count = 0;
  for (const row of stopReasonRows) {
    const rowCode = Number(row?.motive_code);
    if (codes.has(rowCode)) {
      count++;
    }
  }

  return count;
}

/**
 * medianImbalance(param5minRows) → number | null
 *
 * Compute median phase-current imbalance from 5-minute parameter rows.
 *
 * For each row:
 *   1. Extract iac1_a, iac2_a, iac3_a (all must be valid numbers)
 *   2. Skip if any current is NaN/Inf or if avg is 0 (no power)
 *   3. Compute imbalance = (max_deviation / avg) × 100, where
 *      max_deviation = max(|iac_i - avg|) across three phases
 *
 * Returns median of all valid imbalances, or null if no valid samples.
 * Handles edge cases: empty arrays, zero-power rows, partial data.
 *
 * @param {Array|null} param5minRows — array of {iac1_a, iac2_a, iac3_a, ...}
 * @returns {number|null} median imbalance percentage
 */
function medianImbalance(param5minRows) {
  if (!Array.isArray(param5minRows) || param5minRows.length === 0) {
    return null;
  }

  const imbalances = [];

  for (const row of param5minRows) {
    // Extract current values
    const iac1 = row?.iac1_a;
    const iac2 = row?.iac2_a;
    const iac3 = row?.iac3_a;

    // Check all are valid numbers
    if (
      typeof iac1 !== "number" ||
      typeof iac2 !== "number" ||
      typeof iac3 !== "number" ||
      !Number.isFinite(iac1) ||
      !Number.isFinite(iac2) ||
      !Number.isFinite(iac3)
    ) {
      continue;  // Skip incomplete rows
    }

    // Skip zero-power rows (night, disconnected, startup)
    const avg = (iac1 + iac2 + iac3) / 3;
    if (avg === 0) {
      continue;
    }

    // Compute imbalance
    const maxDev = Math.max(
      Math.abs(iac1 - avg),
      Math.abs(iac2 - avg),
      Math.abs(iac3 - avg)
    );
    const imbalance_pct = (maxDev / avg) * 100;

    imbalances.push(imbalance_pct);
  }

  // If no valid samples, return null
  if (imbalances.length === 0) {
    return null;
  }

  // Sort and compute median
  imbalances.sort((a, b) => a - b);

  if (imbalances.length % 2 === 1) {
    // Odd count: return middle element
    return imbalances[Math.floor(imbalances.length / 2)];
  } else {
    // Even count: return average of two middle elements
    const mid = imbalances.length / 2;
    return (imbalances[mid - 1] + imbalances[mid]) / 2;
  }
}

/**
 * medianImbalanceWithCount(param5minRows) → { value, sample_count }
 *
 * Hardened variant of medianImbalance that also returns the number of
 * non-null power-bearing samples used. Callers can use sample_count to
 * decide whether the score's imbalance component is trustworthy:
 *
 *   sample_count === 0  → imbalance was synthesized as 0 (no data)
 *   sample_count <  6   → imbalance based on < 30 min of data (volatile)
 *   sample_count >= 6   → reasonable confidence
 *
 * Use this in new code instead of medianImbalance() so the data-quality
 * flag is visible to the UI / CSV exporter.
 */
function medianImbalanceWithCount(param5minRows) {
  if (!Array.isArray(param5minRows) || param5minRows.length === 0) {
    return { value: null, sample_count: 0 };
  }

  const imbalances = [];
  for (const row of param5minRows) {
    const iac1 = row?.iac1_a;
    const iac2 = row?.iac2_a;
    const iac3 = row?.iac3_a;
    if (
      typeof iac1 !== "number" ||
      typeof iac2 !== "number" ||
      typeof iac3 !== "number" ||
      !Number.isFinite(iac1) ||
      !Number.isFinite(iac2) ||
      !Number.isFinite(iac3)
    ) continue;
    const avg = (iac1 + iac2 + iac3) / 3;
    if (avg === 0) continue;
    const maxDev = Math.max(Math.abs(iac1 - avg), Math.abs(iac2 - avg), Math.abs(iac3 - avg));
    imbalances.push((maxDev / avg) * 100);
  }

  if (imbalances.length === 0) return { value: null, sample_count: 0 };

  imbalances.sort((a, b) => a - b);
  const median = imbalances.length % 2 === 1
    ? imbalances[Math.floor(imbalances.length / 2)]
    : (imbalances[imbalances.length / 2 - 1] + imbalances[imbalances.length / 2]) / 2;

  return { value: median, sample_count: imbalances.length };
}

/**
 * dataQualityFlags({ thermalCount, framaCount, piAnaCount, imbalanceSampleCount, lastEventMs, now }) → flags
 *
 * Produces machine-readable data-quality flags for an IGBT node so the
 * UI can render an honest "insufficient data" state instead of pretending
 * a silent node is healthy.
 *
 * Returns:
 *   {
 *     has_stop_signal:  boolean — any stop events were observed
 *     has_imbalance:    boolean — at least one in-power Iac sample
 *     is_silent:        boolean — no stops AND no Iac samples (likely offline)
 *     stale_param_min:  number|null — minutes since last 5-min param row
 *   }
 */
function dataQualityFlags(inputs) {
  const {
    thermalCount = 0,
    framaCount = 0,
    piAnaCount = 0,
    imbalanceSampleCount = 0,
    lastParamTsMs = null,
    now = Date.now(),
  } = inputs || {};

  const has_stop_signal = (Number(thermalCount) + Number(framaCount) + Number(piAnaCount)) > 0;
  const has_imbalance = Number(imbalanceSampleCount) > 0;
  const is_silent = !has_stop_signal && !has_imbalance;

  let stale_param_min = null;
  if (Number.isFinite(Number(lastParamTsMs)) && lastParamTsMs !== null) {
    const diffMs = Number(now) - Number(lastParamTsMs);
    if (diffMs >= 0) stale_param_min = Math.floor(diffMs / 60000);
  }

  return { has_stop_signal, has_imbalance, is_silent, stale_param_min };
}

// Motive-code groupings — single source of truth for the endpoint layer
// and for cross-correlation in server/acContactorHealth.js.
const AGING_MOTIVES = Object.freeze({
  THERMAL: Object.freeze([7, 21]),              // TEMPERATURA, TEMP_AUX
  FRAMA:   Object.freeze([13, 29, 30]),         // FRAMA1, FRAMA2, FRAMA3
  PI_ANA:  Object.freeze([26]),                 // PI_ANA_SAT
  // Re-exported for symmetry with acContactorHealth.CONTACTOR_STOP_MOTIVES.
  CONTACTOR: Object.freeze([22, 23, 24]),        // PROT_AC, MAGNETO, CONTACTOR
});

// Tier band constants — shared with UI for consistent thresholds.
const TIER_BANDS = Object.freeze({
  HEALTHY_MAX: 25,
  WATCH_MAX:   50,
  AGING_MAX:   75,
});

module.exports = {
  computeHealthScore,
  tierForScore,
  aggregateMotiveCounts,
  medianImbalance,
  // hardening additions (v2.11.x Slice κ):
  medianImbalanceWithCount,
  dataQualityFlags,
  AGING_MOTIVES,
  TIER_BANDS,
};
