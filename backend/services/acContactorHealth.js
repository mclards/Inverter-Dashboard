"use strict";

/**
 * acContactorHealth.js — AC Contactor (K1) Health Score Computation
 *
 * Pure functions — deterministic, side-effect-free, testable in isolation.
 * No database access, no HTTP calls, no timestamps beyond explicit parameters.
 *
 * Scope (v2.11.x Slice κ — paired with IGBT hardening):
 *   The AC contactor K1 sits between the IGBT bridge and the grid. Its
 *   degradation (welded contacts, worn carbonization, coil weakness,
 *   chatter under in-rush) directly drives — and is driven by — IGBT
 *   stress. Asymmetric phase voltages/currents and frequent close/open
 *   cycling are the early-warning signals available WITHOUT new Modbus
 *   reads or schema additions.
 *
 * Signals consumed (all already persisted as of v2.11.0):
 *   1. inverter_stop_reasons_std rows with motive_code ∈ {22,23,24}
 *      - 22 MOTIVO_PARO_PROT_AC      AC controller fault
 *      - 23 MOTIVO_PARO_MAGNETO      thermomagnetic protection trip
 *      - 24 MOTIVO_PARO_CONTACTOR    grid contactor stuck / sensing error
 *   2. alarms rows where (alarm_value & 0x0800) != 0   (bit 11 episodes)
 *      - Fleet-doc-confirmed Contactor Fault for the 920TL hardware.
 *   3. inverter_5min_param rows — phase voltage/current asymmetry
 *      under load. Worn contacts and coil weakness present as elevated
 *      phase-voltage spread when AC current is non-trivial.
 *   4. Chatter proxy: number of distinct bit-11 episodes within a short
 *      rolling window relative to the long window (rapid open/close
 *      cycling appears as multiple short episodes, not one long one).
 *
 * Tier boundaries follow the same band as the IGBT score (manual §5
 * convention):
 *   - Healthy: score < 25
 *   - Watch:   25 ≤ score < 50
 *   - Aging:   50 ≤ score < 75
 *   - EOL:     score ≥ 75
 */

// Motive-code groupings — keep in sync with motiveLabelsStd.js.
const CONTACTOR_STOP_MOTIVES = Object.freeze([22, 23, 24]);
const ALARM_BIT_CONTACTOR_MASK = 0x0800;  // bit 11 — server/alarms.js §11

// Imbalance thresholds — start from manual §5 (>10% imbalance = aging).
// Voltage imbalance threshold is tighter than current because grid voltage
// is held by the utility; large per-phase Vac spread under load indicates
// drop across a high-resistance contact pole, not a grid problem.
const VAC_LOAD_FLOOR_A = 5.0;            // ignore near-zero current rows
const VAC_IMBALANCE_FLOOR_PCT = 1.0;     // below this is healthy noise
const VAC_IMBALANCE_CEIL_PCT = 6.0;      // at/above this the component saturates 100
const IAC_IMBALANCE_FLOOR_PCT = 2.0;
const IAC_IMBALANCE_CEIL_PCT = 15.0;

// Cycle-rate thresholds (K1 mechanical wear from grid-connection cycles).
// A solar inverter normally connects ~1× per day (sunrise) and stays online
// until sunset, so a healthy long-run average is ~1 cycle/day. Anything
// above the floor indicates abnormal cycling (curtailment ping-pong, weak
// grid causing repeated disconnects, contactor chatter that finally
// completes a connect/disconnect, etc).
//   floor: 3 cycles/day → score starts to contribute
//   ceil:  20 cycles/day → component saturates at 100
const CYCLE_RATE_FLOOR_PER_DAY = 3.0;
const CYCLE_RATE_CEIL_PER_DAY  = 20.0;

/**
 * computeContactorScore(inputs) → {score, tier, breakdown, weights_used}
 *
 * Composite contactor-health score from up to SIX components (six since
 * v2.11.x Slice κ — cycle rate added).
 *
 * @param {Object} inputs
 *   @param {number}      [inputs.stop_count=0]           — motive 22/23/24 in window
 *   @param {number}      [inputs.alarm_episode_count=0]  — bit-11 episodes in window
 *   @param {number}      [inputs.chatter_count=0]        — short-burst bit-11 episodes
 *   @param {number|null} [inputs.vac_imbalance_pct=null] — median Vac spread under load
 *   @param {number|null} [inputs.iac_imbalance_pct=null] — median Iac spread under load
 *   @param {number|null} [inputs.cycle_rate_per_day=null] — Δ-Conex per day (rolling)
 *
 * Component formulas (clamp to [0, 100]):
 *   stop_score    = min(100, stop_count    × 35)
 *   alarm_score   = min(100, alarm_count   × 25)
 *   chatter_score = min(100, chatter_count × 50)
 *   vac_score     = remap(vac_imbalance_pct, FLOOR, CEIL → 0..100)
 *   iac_score     = remap(iac_imbalance_pct, FLOOR, CEIL → 0..100)
 *   cycle_score   = remap(cycle_rate, FLOOR, CEIL → 0..100); 0 when null
 *
 * Two weight profiles based on cycle-rate availability:
 *
 *   PHASE-1 (cycle_rate null — fleet still building Conex history):
 *     stop=0.30, alarm=0.25, chatter=0.20, vac=0.15, iac=0.10
 *
 *   PHASE-2 (cycle_rate available — preferred):
 *     stop=0.25, alarm=0.20, chatter=0.20, cycle=0.15, vac=0.12, iac=0.08
 *
 * Both profiles sum to 1.0; phase-1 is a pure subset of phase-2 with the
 * cycle weight redistributed. This lets existing nodes keep scoring while
 * Conex data accumulates over the first 24-48 h post-deploy.
 */
function computeContactorScore(inputs = {}) {
  const {
    stop_count = 0,
    alarm_episode_count = 0,
    chatter_count = 0,
    vac_imbalance_pct = null,
    iac_imbalance_pct = null,
    cycle_rate_per_day = null,
  } = inputs;

  const stop_score    = _clamp01(stop_count * 35);
  const alarm_score   = _clamp01(alarm_episode_count * 25);
  const chatter_score = _clamp01(chatter_count * 50);
  const vac_score     = _remapImbalance(vac_imbalance_pct, VAC_IMBALANCE_FLOOR_PCT, VAC_IMBALANCE_CEIL_PCT);
  const iac_score     = _remapImbalance(iac_imbalance_pct, IAC_IMBALANCE_FLOOR_PCT, IAC_IMBALANCE_CEIL_PCT);

  const cycleAvailable = typeof cycle_rate_per_day === "number"
                          && Number.isFinite(cycle_rate_per_day);
  const cycle_score = cycleAvailable
    ? _remapImbalance(cycle_rate_per_day, CYCLE_RATE_FLOOR_PER_DAY, CYCLE_RATE_CEIL_PER_DAY)
    : null;

  let weights, phase, score;
  if (cycleAvailable) {
    weights = { stop: 0.25, alarm: 0.20, chatter: 0.20, cycle: 0.15, vac: 0.12, iac: 0.08 };
    phase = "phase2";
    score =
      weights.stop    * stop_score    +
      weights.alarm   * alarm_score   +
      weights.chatter * chatter_score +
      weights.cycle   * cycle_score   +
      weights.vac     * vac_score     +
      weights.iac     * iac_score;
  } else {
    weights = { stop: 0.30, alarm: 0.25, chatter: 0.20, vac: 0.15, iac: 0.10 };
    phase = "phase1";
    score =
      weights.stop    * stop_score    +
      weights.alarm   * alarm_score   +
      weights.chatter * chatter_score +
      weights.vac     * vac_score     +
      weights.iac     * iac_score;
  }

  return {
    score: Math.round(score * 10) / 10,
    tier: tierForScore(score),
    breakdown: {
      stop_score:    _round1(stop_score),
      alarm_score:   _round1(alarm_score),
      chatter_score: _round1(chatter_score),
      vac_score:     _round1(vac_score),
      iac_score:     _round1(iac_score),
      cycle_score:   cycle_score == null ? null : _round1(cycle_score),
    },
    weights_used: { phase, weights },
  };
}

/**
 * tierForScore(score) — same band convention as IGBT health.
 */
function tierForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score < 25) return "healthy";
  if (score < 50) return "watch";
  if (score < 75) return "aging";
  return "eol";
}

/**
 * countContactorStops(stopReasonRows) → number
 *
 * Count rows whose motive_code ∈ {22,23,24}. Safely handles null/missing
 * fields. Re-uses the canonical CONTACTOR_STOP_MOTIVES set so downstream
 * callers don't have to remember the codes.
 */
function countContactorStops(stopReasonRows) {
  if (!Array.isArray(stopReasonRows) || stopReasonRows.length === 0) return 0;
  const set = new Set(CONTACTOR_STOP_MOTIVES);
  let count = 0;
  for (const row of stopReasonRows) {
    const code = Number(row?.motive_code);
    if (set.has(code)) count++;
  }
  return count;
}

/**
 * countContactorAlarmEpisodes(alarmRows) → number
 *
 * Each row should already have alarm_value (INTEGER bitmap). We count
 * distinct rows where bit 11 (0x0800) was set. The caller decides which
 * rows are "episodes" vs raw frames — typically pre-filtered with
 *
 *   SELECT id, ts, alarm_value, cleared_ts FROM alarms
 *     WHERE inverter=? AND unit=? AND ts > ?
 *           AND (alarm_value & 2048) != 0
 *
 * so this function just sums them up. Safe on null.
 */
function countContactorAlarmEpisodes(alarmRows) {
  if (!Array.isArray(alarmRows) || alarmRows.length === 0) return 0;
  let count = 0;
  for (const row of alarmRows) {
    const v = Number(row?.alarm_value);
    if (Number.isFinite(v) && (v & ALARM_BIT_CONTACTOR_MASK) !== 0) count++;
  }
  return count;
}

/**
 * detectChatter(alarmRows, opts) → number
 *
 * Chatter = the contactor opens/closes faster than mechanical wear can
 * survive. We detect it as bit-11 alarm episodes that *cleared* within
 * `chatterMaxDurationMs` (default 60 s) — a real contactor fault that
 * required intervention will stay raised much longer; a chattering
 * contactor will toggle quickly.
 *
 * Rows must include `ts` and `cleared_ts` (cleared_ts null = still
 * raised = NOT chatter, NOT counted). Rows with bit 11 not set are
 * ignored.
 *
 * @param {Array} alarmRows — alarms rows (need ts, cleared_ts, alarm_value)
 * @param {Object} [opts]
 * @param {number} [opts.chatterMaxDurationMs=60000]
 * @returns {number} count of short-lived bit-11 episodes
 */
function detectChatter(alarmRows, opts) {
  if (!Array.isArray(alarmRows) || alarmRows.length === 0) return 0;
  const { chatterMaxDurationMs = 60000 } = opts || {};
  let count = 0;
  for (const row of alarmRows) {
    const v = Number(row?.alarm_value);
    if (!Number.isFinite(v) || (v & ALARM_BIT_CONTACTOR_MASK) === 0) continue;
    const ts = Number(row?.ts);
    const cleared = Number(row?.cleared_ts);
    if (!Number.isFinite(ts) || !Number.isFinite(cleared) || cleared <= ts) continue;
    if ((cleared - ts) <= chatterMaxDurationMs) count++;
  }
  return count;
}

/**
 * vacImbalanceUnderLoad(param5minRows, opts) → number|null
 *
 * Median percentage spread between the highest and lowest phase voltage,
 * normalized by the average phase voltage. Only rows where the average
 * AC current exceeds VAC_LOAD_FLOOR_A contribute — voltage spread on a
 * floating bus is meaningless.
 *
 * Returns null if no rows meet the load floor.
 *
 *   spread_pct = (max(vac1,vac2,vac3) - min(...)) / avg(...) × 100
 *
 * Worn or pitted K1 contacts present as a sustained 2-5% Vac spread
 * under load even though the grid is balanced.
 */
function vacImbalanceUnderLoad(param5minRows, opts) {
  if (!Array.isArray(param5minRows) || param5minRows.length === 0) return null;
  const { loadFloorA = VAC_LOAD_FLOOR_A } = opts || {};
  const samples = [];
  for (const row of param5minRows) {
    const v1 = Number(row?.vac1_v);
    const v2 = Number(row?.vac2_v);
    const v3 = Number(row?.vac3_v);
    if (![v1, v2, v3].every(Number.isFinite)) continue;
    if (v1 <= 0 || v2 <= 0 || v3 <= 0) continue;
    const i1 = Number(row?.iac1_a);
    const i2 = Number(row?.iac2_a);
    const i3 = Number(row?.iac3_a);
    if (![i1, i2, i3].every(Number.isFinite)) continue;
    const iAvg = (i1 + i2 + i3) / 3;
    if (iAvg < loadFloorA) continue;
    const vAvg = (v1 + v2 + v3) / 3;
    if (vAvg <= 0) continue;
    const spread = (Math.max(v1, v2, v3) - Math.min(v1, v2, v3)) / vAvg * 100;
    samples.push(spread);
  }
  return _median(samples);
}

/**
 * iacImbalanceUnderLoad(param5minRows, opts) → number|null
 *
 * Same shape as vacImbalanceUnderLoad but for AC currents. Re-uses the
 * IGBT-side imbalance definition (max-deviation-from-mean), since that
 * is also the contactor-relevant measure: a high-resistance contact on
 * one pole shows as a sustained drop in that phase's current.
 *
 * The IGBT module exports an equivalent function (medianImbalance) but
 * with a slightly different definition (max |i_phase - avg| / avg).
 * Kept here for symmetry with vacImbalanceUnderLoad and to avoid an
 * accidental cross-module formula drift.
 */
function iacImbalanceUnderLoad(param5minRows, opts) {
  if (!Array.isArray(param5minRows) || param5minRows.length === 0) return null;
  const { loadFloorA = VAC_LOAD_FLOOR_A } = opts || {};
  const samples = [];
  for (const row of param5minRows) {
    const i1 = Number(row?.iac1_a);
    const i2 = Number(row?.iac2_a);
    const i3 = Number(row?.iac3_a);
    if (![i1, i2, i3].every(Number.isFinite)) continue;
    const iAvg = (i1 + i2 + i3) / 3;
    if (iAvg < loadFloorA) continue;
    const maxDev = Math.max(Math.abs(i1 - iAvg), Math.abs(i2 - iAvg), Math.abs(i3 - iAvg));
    samples.push((maxDev / iAvg) * 100);
  }
  return _median(samples);
}

/**
 * computeCycleRatePerDay(snapshots) → { rate_per_day, total_delta, span_days, samples_used }
 *
 * Given a chronologically-ordered list of Conex snapshots (objects with
 * `ts_ms` and `value`), compute the per-day grid-connection-cycle rate.
 *
 * @param {Array<{ts_ms:number, value:number}>} snapshots — monotonic UInt32
 *   counter snapshots ordered oldest → newest.
 *
 * Algorithm:
 *   1. Filter out null/undefined/non-finite/zero values (zero only valid as
 *      the first sample on a brand-new commissioned inverter; we conservatively
 *      ignore it so a transient bad sample can't deflate the rate).
 *   2. Walk pairwise, summing only non-negative deltas (UInt32 wrap-around
 *      is essentially impossible at < 4 billion cycles, but a value going
 *      DOWN can only be an inverter reset or a read glitch — skip it).
 *   3. Divide by elapsed wall-clock span (in days).
 *
 * Returns:
 *   rate_per_day  — cycles/day (null if span < 1 h or zero usable samples)
 *   total_delta   — sum of monotone-increasing deltas
 *   span_days     — elapsed wall-clock span in days
 *   samples_used  — count of snapshots that passed the filter
 */
function computeCycleRatePerDay(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return { rate_per_day: null, total_delta: 0, span_days: 0, samples_used: 0 };
  }
  const clean = [];
  for (const s of snapshots) {
    const ts = Number(s?.ts_ms);
    const v  = Number(s?.value);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!Number.isFinite(v) || v <= 0) continue;
    clean.push({ ts_ms: ts, value: v });
  }
  if (clean.length < 2) {
    return { rate_per_day: null, total_delta: 0, span_days: 0, samples_used: clean.length };
  }
  clean.sort((a, b) => a.ts_ms - b.ts_ms);
  let total = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i].value - clean[i - 1].value;
    if (d > 0) total += d;  // ignore regressions (reset / glitch)
  }
  const spanMs = clean[clean.length - 1].ts_ms - clean[0].ts_ms;
  const spanDays = spanMs / 86_400_000;
  if (spanDays < (1 / 24)) {
    // Less than 1 h of history — rate isn't statistically meaningful yet.
    return { rate_per_day: null, total_delta: total, span_days: spanDays, samples_used: clean.length };
  }
  return {
    rate_per_day: total / spanDays,
    total_delta:  total,
    span_days:    spanDays,
    samples_used: clean.length,
  };
}

/**
 * correlateWithIgbt({ contactor, igbt }) → {linked, reasons, severity}
 *
 * Produce the "Linked Findings" payload that the dashboard surfaces in
 * both the IGBT and Contactor drilldowns. The detector is symmetric so
 * we share the same logic both ways.
 *
 * Inputs (all optional — missing fields contribute no link):
 *   contactor.stop_count, contactor.alarm_episode_count,
 *   contactor.chatter_count, contactor.score, contactor.tier
 *   igbt.frama_count, igbt.thermal_count, igbt.imbalance_pct,
 *   igbt.score, igbt.tier
 *
 * Output:
 *   linked   — true iff at least one cross-correlation rule fires
 *   reasons  — array of human-readable strings (UI renders as bullets)
 *   severity — "info" | "watch" | "act"
 *
 * Rules (rationale in §11 of the audit doc):
 *   R1 chatter ∧ FRAMA      → chattering K1 produces fault current
 *                              spikes that trip the IGBT branch protection
 *   R2 high Iac imbalance ∧ contactor stops
 *                            → one K1 pole carrying less current than
 *                              the others (carbonization on that pole)
 *   R3 EOL tiers on BOTH    → coupled failure, schedule joint replacement
 *   R4 thermal trips ∧ chatter → in-rush surges raising junction temp
 */
function correlateWithIgbt(payload) {
  const reasons = [];
  let severity = "info";

  const ct = payload?.contactor || {};
  const ig = payload?.igbt || {};

  const chatter      = Number(ct.chatter_count || 0);
  const ctStops      = Number(ct.stop_count || 0);
  const ctAlarmEps   = Number(ct.alarm_episode_count || 0);
  const framaCount   = Number(ig.frama_count || 0);
  const thermalCount = Number(ig.thermal_count || 0);
  const iacImbal     = ig.imbalance_pct;

  if (chatter > 0 && framaCount > 0) {
    reasons.push(
      `K1 chatter (${chatter} short-cycle episode${chatter > 1 ? "s" : ""}) ` +
      `co-occurs with ${framaCount} FRAMA branch fault${framaCount > 1 ? "s" : ""} — ` +
      `chatter in-rush is a known IGBT branch-protection trigger.`
    );
    severity = "act";
  }

  if (ctStops > 0 && typeof iacImbal === "number" && Number.isFinite(iacImbal) && iacImbal >= 5) {
    reasons.push(
      `Phase-current imbalance ${iacImbal.toFixed(1)}% with ${ctStops} contactor stop${ctStops > 1 ? "s" : ""} — ` +
      `inspect K1 pole resistance, one pole may be carrying less current.`
    );
    if (severity !== "act") severity = "watch";
  }

  if (ct.tier === "eol" && ig.tier === "eol") {
    reasons.push(
      "Both IGBT and AC contactor are tier EOL — schedule a joint K1 + IGBT module replacement; " +
      "ignoring one will accelerate failure of the other."
    );
    severity = "act";
  }

  if (thermalCount > 0 && chatter > 0) {
    reasons.push(
      `${thermalCount} thermal trip${thermalCount > 1 ? "s" : ""} alongside ${chatter} K1 chatter event${chatter > 1 ? "s" : ""} — ` +
      "repeated in-rush from chatter elevates junction temperature; the thermal trips may be a symptom, not the root cause."
    );
    if (severity !== "act") severity = "watch";
  }

  // Soft link: any contactor alarm episode while IGBT is already aging
  if (ctAlarmEps > 0 && (ig.tier === "aging" || ig.tier === "eol") && reasons.length === 0) {
    reasons.push(
      `${ctAlarmEps} contactor alarm episode${ctAlarmEps > 1 ? "s" : ""} on a tier ${ig.tier} IGBT — ` +
      "track jointly; contactor wear often masquerades as IGBT aging."
    );
  }

  return {
    linked: reasons.length > 0,
    reasons,
    severity: reasons.length === 0 ? "info" : severity,
  };
}

// ── private helpers ────────────────────────────────────────────────────────

function _clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

function _remapImbalance(value, floor, ceil) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= floor) return 0;
  if (value >= ceil) return 100;
  return ((value - floor) / (ceil - floor)) * 100;
}

function _round1(x) {
  return Math.round((Number.isFinite(x) ? x : 0) * 10) / 10;
}

function _median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = {
  // scoring
  computeContactorScore,
  tierForScore,
  // aggregators
  countContactorStops,
  countContactorAlarmEpisodes,
  detectChatter,
  vacImbalanceUnderLoad,
  iacImbalanceUnderLoad,
  computeCycleRatePerDay,
  // cross-correlation
  correlateWithIgbt,
  // constants exposed for tests + endpoint reuse
  CONTACTOR_STOP_MOTIVES,
  ALARM_BIT_CONTACTOR_MASK,
  VAC_LOAD_FLOOR_A,
  VAC_IMBALANCE_FLOOR_PCT,
  VAC_IMBALANCE_CEIL_PCT,
  IAC_IMBALANCE_FLOOR_PCT,
  IAC_IMBALANCE_CEIL_PCT,
  CYCLE_RATE_FLOOR_PER_DAY,
  CYCLE_RATE_CEIL_PER_DAY,
};
