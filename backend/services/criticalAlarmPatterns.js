"use strict";

/**
 * criticalAlarmPatterns.js — forensic precursor signatures for catastrophic
 * IGBT failure (v2.11.x Slice κ.3).
 *
 * Each pattern is a specific multi-bit AND mask on `alarm_value`. When the
 * mask matches, the firmware reported all named bits simultaneously — a
 * hardware-side correlated event with diagnostic meaning beyond any single
 * bit. These patterns were identified by operator-side forensic analysis
 * after the 2026-05-11 substrate-breach explosion incident.
 *
 * Patterns:
 *
 *   0x0240 (bits 6 + 9) — DC Substrate Breach Precursor
 *     ADC/Sync chain disturbed + DC Protection Fault. Indicates DC bus
 *     instability severe enough to corrupt the analog measurement chain.
 *     Recurring episodes accumulate Vds-margin damage on the IGBT
 *     substrate (ceramic isolation), increasing the risk of a
 *     substrate-breaching explosion that welds K1 contacts and trips
 *     QAC + GFCI simultaneously.
 *
 *   0x0210 (bits 4 + 9) — DC Fault + AC Overcurrent Precursor
 *     RMS Overcurrent + DC Protection Fault. Indicates the bridge was
 *     driven into AC overcurrent during a DC-side disturbance. Bond-wire
 *     fatigue accumulates faster than design lifetime.
 *
 * Both remaining patterns share bit 9 (DC Protection Fault). The
 * discriminator between them is bit 6 (measurement-side disruption) vs
 * bit 4 (current-side overload). Either pattern recurring on a 48-hour
 * rolling window is considered CRITICAL — escalate to the inverter
 * engineer.
 *
 * Note: 0x0040 (bit 6 alone, ADC / Sync persistent without DC-protection
 * trip) was previously a third entry in this catalogue but was removed in
 * Slice κ.7 (2026-05-12) after the field observed it auto-blocking
 * inverters with no real precursor signature. See the catalogue comment
 * below for the rationale.
 *
 * Recurrence rule (operator-set 2026-05-12, tightened from 2026-05-11):
 *   ≥ MIN_COUNT episodes in WINDOW_MS for the same pattern, same node →
 *   `recurring=true` → severity `critical`. Defaults are 3-in-48h with a
 *   60-min flap-dedup spacing.
 *
 * Pure functions only — no DB, no I/O, no clock reads except via
 * explicit `now` parameter. Caller hands in alarm rows pre-fetched from
 * the alarms table.
 */

// Pattern catalogue. `severity_rank` ranks the FAILURE MODE severity (NOT
// the current state). Higher rank = worse failure mode. Operator ruling
// (2026-05-12): 0x0240 outranks 0x0210 because a substrate-breaching
// explosion is catastrophic and immediate, whereas bond-wire fatigue is
// degenerative. IGBT_HEALTH_EOL (synthetic preventive signal, emitted by
// server/index.js) slots between the two as a graceful-warning rank.
//
// Rank scale (higher = worse, must auto-block sooner):
//   4 → 0x0240            DC Substrate Breach Precursor   (immediate explosion mode)
//   3 → IGBT_HEALTH_EOL                                   (preventive synthetic, EOL wear)
//   1 → 0x0210            DC Fault + AC Overcurrent       (degenerative)
//
// Slice κ.7 — `0x0040` (ADC / Sync Persisting) was REMOVED from the
// auto-block catalogue on 2026-05-12 after field observation: bit 6 alone
// (ADC/sync disturbance without coupled DC-protection trip) fires often
// enough during normal operation that 2-in-48h auto-blocks were stopping
// fleet inverters with no real precursor signature. The escalated form
// (0x0240, bits 6+9) remains in the catalogue — that one is genuinely
// catastrophic. Operators who want visibility into bit-6-only events can
// still see them in the alarm history; we just no longer auto-stop the
// inverter for them. Tightened thresholds (DEFAULT_MIN_COUNT raised to 3,
// DEFAULT_MIN_EPISODE_SPACING_MS raised to 60 min) further reduce the
// false-positive surface on the remaining two patterns.
const CRITICAL_PATTERNS = Object.freeze([
  Object.freeze({
    key: "DC_SUBSTRATE_BREACH",
    mask: 0x0240,
    hex: "0x0240",
    severity_rank: 4,  // worst — catastrophic IGBT explosion + K1 weld + QAC/GFCI trip
    bits: Object.freeze([6, 9]),
    bit_labels: Object.freeze(["ADC / Sync Error", "DC Protection Fault"]),
    label: "DC Substrate Breach Precursor",
    description:
      "DC bus instability with analog measurement chain disruption. " +
      "Recurring episodes erode IGBT Vds margin and stress ceramic substrate isolation.",
    failure_mode:
      "Substrate-breaching IGBT explosion with K1 contact weld and " +
      "simultaneous QAC + GFCI trip. Module fragmentation through ceramic isolation.",
    recommended_action:
      "Schedule inverter-engineer review. Inspect DC bus stability (Vdc swings), " +
      "Zpos / Zneg insulation trend, DC-link capacitor bank health, and K1 contact wear " +
      "(any prior bit-11 episodes or unusual Conex cycle rate).",
  }),
  Object.freeze({
    key: "DC_FAULT_AC_OVERCURRENT",
    mask: 0x0210,
    hex: "0x0210",
    severity_rank: 1,  // degenerative — bond-wire fatigue, IGBT bridge stress
    bits: Object.freeze([4, 9]),
    bit_labels: Object.freeze(["RMS Overcurrent", "DC Protection Fault"]),
    label: "DC Fault + AC Overcurrent Precursor",
    description:
      "DC-side protection trip co-occurring with sustained AC RMS overcurrent. " +
      "Bridge is driven into elevated stress during DC disturbances.",
    failure_mode:
      "IGBT bridge under sustained over-current. Bond-wire fatigue accumulates " +
      "faster than design lifetime. Typical failure: bond-wire lift-off or die punch-through.",
    recommended_action:
      "Schedule inverter-engineer review. Inspect IGBT bridge integrity, gate-drive " +
      "circuit health, freewheel diode condition, and DC-link capacitor ESR. " +
      "Cross-check with FRAMA stop counts on the same node.",
  }),
]);

// O(1) lookup by pattern key for callers that need the catalogue entry
// (used by the enforcer to compare priorities of the active block vs the
// currently-worst critical pattern).
const PATTERN_BY_KEY = Object.freeze(Object.fromEntries(
  CRITICAL_PATTERNS.map((p) => [p.key, p]),
));

/**
 * patternSeverityRank(key) → number
 * Returns the catalogue's severity_rank for `key`, or 0 if unknown.
 * Used by decideBlockAction to pick the worst pattern when multiple are
 * critical simultaneously, and to decide whether to promote an active
 * block to a more-severe pattern.
 */
function patternSeverityRank(key) {
  return Number(PATTERN_BY_KEY[String(key || "")]?.severity_rank) || 0;
}

// Default recurrence window + threshold. Operator-tunable per call.
//
// Slice κ.7 (2026-05-12) — DEFAULT_MIN_COUNT raised from 2 → 3 after field
// observation that the 2-episode threshold was firing during normal
// operation under noisy line conditions (especially around dawn/dusk
// transitions). Requiring 3 spaced-apart episodes within 48 h sharply
// reduces auto-block false positives while still catching a genuine
// recurring fault well before the next solar cycle.
const DEFAULT_WINDOW_MS  = 48 * 60 * 60 * 1000;   // 2 days
const DEFAULT_MIN_COUNT  = 3;                     // ≥ 3 episodes = recurring (was 2)

// v2.11.x Slice κ.4 false-positive hardening:
//
// 1) DEFAULT_MIN_EPISODE_SPACING_MS — minimum gap between two episodes
//    before both are counted toward `count_in_window`. Below this, the
//    second is treated as a flap of the first. The inverter's alarm
//    register can re-raise the same bits within seconds on noisy lines;
//    without this gate, a single underlying fault could create dozens
//    of "episodes" in a minute and trigger an unnecessary auto-block.
//    Operator-tunable per call via `opts.minSpacingMs`. Set to 0 in
//    tests where deterministic counts matter.
//
// 2) MAX_ALARM_BITS_FOR_PATTERN — alarms with more than this many bits
//    set are treated as sensor / firmware glitches and NOT counted.
//    Real INGECON alarm payloads rarely raise more than 4–5 simultaneous
//    bits; an `alarm_value = 0xFFFF` (16 bits) is almost always a comm
//    reset or sensor failure, and superset-aware matching would let
//    that single bogus row look like both 0x0240 and 0x0210 at once.
// Slice κ.7 (2026-05-12) — spacing raised from 30 → 60 min. Combined with
// MIN_COUNT=3, an inverter now needs three independent fault episodes,
// each at least an hour apart, inside a 48 h window before the auto-block
// fires. That maps to about ~3 hours of accumulated misbehaviour minimum,
// which matches the operator's tolerance for "this is real, not a flap."
const DEFAULT_MIN_EPISODE_SPACING_MS = 60 * 60 * 1000;  // 60 min (was 30)
const MAX_ALARM_BITS_FOR_PATTERN     = 8;

// Hamming weight (popcount) over the LOW 16 bits only. Used by the
// suspect-alarm filter to reject `alarm_value`s that have too many bits set
// to be a real INGECON fault pattern.
//
// v2.1 note: `alarm_value` is now the full 32-bit regs 6-7 field, but every
// CRITICAL_PATTERNS mask and every catalogued ALARM_BITS entry lives in bits
// 0-15. Scoping the glitch heuristic to the low word is therefore correct
// AND conservative: a high-word-only noise burst can never *suppress* a
// genuine low-word pattern match (popcount only ever returns "no match").
// Do NOT widen this to 32-bit without re-tuning MAX_ALARM_BITS_FOR_PATTERN —
// it is an operator-tuned safety heuristic (Slice κ.4).
function _popcount16(v) {
  let x = (Number(v) | 0) & 0xFFFF;
  x = x - ((x >> 1) & 0x5555);
  x = (x & 0x3333) + ((x >> 2) & 0x3333);
  x = (x + (x >> 4)) & 0x0F0F;
  return (x * 0x0101) >> 8 & 0xFF;
}

/**
 * matchesPattern(alarmValue, mask, excludeMask?)
 *
 * True if every bit in `mask` is set in `alarmValue` AND no bit in
 * `excludeMask` is set in `alarmValue`.
 *
 * v2.11.x Slice κ.4 hardening: alarm values with more than
 * MAX_ALARM_BITS_FOR_PATTERN bits set are treated as sensor / firmware
 * glitches (an `alarm_value = 0xFFFF` is almost always a comm reset, not
 * a real fault) and explicitly do NOT match any pattern, even though the
 * superset rule would otherwise let them match every catalogue entry.
 *
 * v2.11.x Slice κ.6: `excludeMask` lets a catalogue entry be MUTUALLY
 * EXCLUSIVE with a more-severe entry that's a strict superset. No active
 * pattern uses this in Slice κ.7+ — 0x0040 was the last consumer, and it
 * was removed from the catalogue when bit-6-only auto-blocks proved too
 * noisy in the field. The mechanism is retained for future catalogue
 * additions that need similar disambiguation.
 */
function matchesPattern(alarmValue, mask, excludeMask) {
  const v = Number(alarmValue);
  const m = Number(mask);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return false;
  if (m === 0) return false;
  if ((v | 0) === 0) return false;
  // Suspect-glitch gate (Slice κ.4): a sane alarm payload won't raise
  // more than half the 16-bit register simultaneously.
  if (_popcount16(v) > MAX_ALARM_BITS_FOR_PATTERN) return false;
  if ((v & m) !== m) return false;
  const x = Number(excludeMask) || 0;
  if (x !== 0 && (v & x) !== 0) return false;  // exclude (Slice κ.6)
  return true;
}

/**
 * countPatternEpisodesInWindow(alarmRows, mask, now, windowMs, minSpacingMs?)
 * Returns { count, last_seen_ts, first_seen_ts, episodes, raw_matches }.
 *
 * `alarmRows` may carry the full alarms-table shape (id, ts, cleared_ts,
 * alarm_value). Only `ts` and `alarm_value` are required for matching.
 *
 * v2.11.x Slice κ.4 false-positive hardening:
 *   - `minSpacingMs` (default DEFAULT_MIN_EPISODE_SPACING_MS = 30 min)
 *     coalesces tightly-spaced flaps into a single counted episode. A
 *     noisy line that re-raises the same bit pattern 5× in 1 min should
 *     score as ONE episode, not five — otherwise the 2-in-48h threshold
 *     trips on a single underlying fault. Setting `minSpacingMs = 0`
 *     restores the legacy "count every matching row" behaviour for tests.
 *   - `raw_matches` is the pre-dedup count, surfaced so the UI/audit can
 *     show "12 raw events deduped to 3 episodes" without re-querying.
 */
function countPatternEpisodesInWindow(alarmRows, mask, now, windowMs, minSpacingMs, excludeMask) {
  const w = Number.isFinite(Number(windowMs)) && windowMs > 0
    ? Number(windowMs)
    : DEFAULT_WINDOW_MS;
  const _now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoff = _now - w;
  const spacing = (minSpacingMs == null)
    ? DEFAULT_MIN_EPISODE_SPACING_MS
    : Math.max(0, Number(minSpacingMs) || 0);
  const out = {
    count: 0, last_seen_ts: null, first_seen_ts: null,
    episodes: [], raw_matches: 0,
  };
  if (!Array.isArray(alarmRows) || alarmRows.length === 0) return out;

  // First pass — collect matching rows inside the window.
  const matched = [];
  for (const row of alarmRows) {
    const ts = Number(row?.ts);
    const v  = Number(row?.alarm_value);
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    if (ts < cutoff) continue;
    if (!matchesPattern(v, mask, excludeMask)) continue;
    matched.push({
      ts, alarm_value: v,
      cleared_ts: row?.cleared_ts ?? null,
      id: row?.id ?? null,
    });
  }
  out.raw_matches = matched.length;

  // Second pass — dedup by spacing. Sort DESC so the most-recent match
  // anchors each episode (operator cares more about "when did this last
  // fire" than when the cluster started). A row inside the spacing window
  // of an already-accepted episode is treated as a flap of that episode.
  matched.sort((a, b) => b.ts - a.ts);
  for (const m of matched) {
    if (out.episodes.length > 0 && spacing > 0) {
      // out.episodes[0] is always the latest accepted episode (DESC order).
      // Reject if this match is within `spacing` of any already-accepted
      // episode. Walk all accepted (small list — at most ~20 for 48h).
      let isFlap = false;
      for (const ep of out.episodes) {
        if (Math.abs(ep.ts - m.ts) < spacing) { isFlap = true; break; }
      }
      if (isFlap) continue;
    }
    out.episodes.push(m);
    out.count++;
    if (out.last_seen_ts == null || m.ts > out.last_seen_ts) out.last_seen_ts = m.ts;
    if (out.first_seen_ts == null || m.ts < out.first_seen_ts) out.first_seen_ts = m.ts;
  }
  return out;
}

/**
 * evaluateCriticalPatterns(alarmRows, opts?) → Array<patternStatus>
 *
 * One patternStatus per known CRITICAL_PATTERNS entry. Caller can render
 * each, regardless of severity (no findings still renders an "all clear"
 * row). Severity escalates:
 *   - 0 episodes              → "ok"
 *   - 1 episode in window     → "watch"
 *   - >= MIN_COUNT episodes   → "critical"
 *
 * @param {Array} alarmRows
 * @param {Object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.windowMs=48h]
 * @param {number} [opts.minCount=2]
 * @param {number} [opts.minSpacingMs=30min]  episode-spacing dedup (Slice κ.4)
 */
function evaluateCriticalPatterns(alarmRows, opts) {
  const o = opts || {};
  const now      = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const windowMs = Number.isFinite(Number(o.windowMs)) && o.windowMs > 0
    ? Number(o.windowMs)
    : DEFAULT_WINDOW_MS;
  const minCount = Number.isFinite(Number(o.minCount)) && o.minCount > 0
    ? Math.floor(Number(o.minCount))
    : DEFAULT_MIN_COUNT;
  // Slice κ.4 — spacing default kicks in when opts.minSpacingMs is omitted;
  // explicit `0` bypasses dedup (used by deterministic tests).
  const minSpacingMs = (o.minSpacingMs == null)
    ? DEFAULT_MIN_EPISODE_SPACING_MS
    : Math.max(0, Number(o.minSpacingMs) || 0);

  const results = [];
  for (const pat of CRITICAL_PATTERNS) {
    const stats = countPatternEpisodesInWindow(
      alarmRows, pat.mask, now, windowMs, minSpacingMs, pat.exclude_mask || 0,
    );
    const recurring = stats.count >= minCount;
    let severity;
    if (recurring) severity = "critical";
    else if (stats.count > 0) severity = "watch";
    else severity = "ok";
    results.push({
      key: pat.key,
      mask: pat.mask,
      hex: pat.hex,
      exclude_mask: pat.exclude_mask || 0,
      severity_rank: pat.severity_rank,
      bits: pat.bits,
      bit_labels: pat.bit_labels,
      label: pat.label,
      description: pat.description,
      failure_mode: pat.failure_mode,
      recommended_action: pat.recommended_action,
      count_in_window: stats.count,
      raw_matches: stats.raw_matches,         // pre-dedup matching rows (Slice κ.4 forensic)
      min_spacing_ms: minSpacingMs,           // gate setting in effect
      window_ms: windowMs,
      min_count_for_critical: minCount,
      first_seen_ts: stats.first_seen_ts,
      last_seen_ts:  stats.last_seen_ts,
      recurring,
      severity,
      episodes: stats.episodes.slice(0, 20),
    });
  }
  return results;
}

/**
 * hasAnyCriticalPattern(statuses)
 * Quick boolean for whether *any* pattern reached critical severity.
 * Used by the UI to decide row-level highlighting and fleet-wide banner.
 */
function hasAnyCriticalPattern(statuses) {
  if (!Array.isArray(statuses)) return false;
  return statuses.some((s) => s && s.severity === "critical");
}

/**
 * worstSeverity(statuses) → "critical" | "watch" | "ok"
 * Returns the highest-severity tier seen across all pattern statuses.
 */
function worstSeverity(statuses) {
  if (!Array.isArray(statuses)) return "ok";
  if (statuses.some((s) => s?.severity === "critical")) return "critical";
  if (statuses.some((s) => s?.severity === "watch")) return "watch";
  return "ok";
}

module.exports = {
  CRITICAL_PATTERNS,
  PATTERN_BY_KEY,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_COUNT,
  DEFAULT_MIN_EPISODE_SPACING_MS,
  MAX_ALARM_BITS_FOR_PATTERN,
  matchesPattern,
  countPatternEpisodesInWindow,
  evaluateCriticalPatterns,
  hasAnyCriticalPattern,
  worstSeverity,
  patternSeverityRank,
};
