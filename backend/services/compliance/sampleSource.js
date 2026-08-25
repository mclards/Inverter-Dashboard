"use strict";

/**
 * sampleSource.js — pure shape helper that converts a poller live frame into
 * the compliance sample shape consumed by CaptureBuffer + testT2/T3/T5.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ
 *
 * Why this exists
 * ──────────────
 * The original compliance sampler (server/index.js _fetchLiveSampleForCompliance)
 * read from `inverter_5min_param` — a 5-MINUTE rolling aggregate. T2/T3/T5
 * sample at 2 s, so every real DB row was duplicated ~150× and:
 *   • T2 frequency observation: 30-min run captured ~6 unique frequency points
 *     instead of ~900, masking grid excursions entirely.
 *   • T5 APC sweep: achieved-value averaging trailed reality by 2-3 minutes,
 *     so a clean 100→25→100 % ramp would frequently false-fail.
 *   • T3 Q-V sweep: PF derivation (cosphi or P+Q) lagged the setpoint by
 *     several plateaus.
 *
 * Fix: read `poller.getLiveData()[`${inverter}_${unit}`]` first (refreshes
 * every poll cycle, ≤ 5 s typical), only fall back to the 5-min table when
 * the live frame is missing or stale (older than `liveFreshMs`, default 15 s).
 *
 * This module is the field-mapping core. All I/O (DB query, ipconfig load)
 * lives in server/index.js; this module is pure so it can be unit-tested
 * without SQLite or pymodbus mocks.
 */

const LIVE_FRESH_MS_DEFAULT = 15_000;

/**
 * Build an `ip → inverterNumber` lookup from the persisted ipconfig object map.
 * Mirrors poller.buildIpConfigLookup but returns just the byIp side, so this
 * module doesn't need to require the entire poller surface.
 */
function buildIpToInverterMap(ipConfig) {
  const out = new Map();
  const inverters = ipConfig?.inverters;
  if (!inverters || typeof inverters !== "object") return out;
  for (let inv = 1; inv <= 27; inv++) {
    const ip = String(inverters[inv] ?? inverters[String(inv)] ?? "").trim();
    if (ip) out.set(ip, inv);
  }
  return out;
}

/**
 * Convert a poller `liveData` frame into the compliance sample shape.
 * Returns null when the frame is null/undefined.
 *
 * Field name mapping (live frame → sample row):
 *   pac (W after Slice α scaling)        → pac_w
 *   qac_var                              → qac_var
 *   vac1/vac2/vac3 mean                  → vac_avg_v
 *   iac1/iac2/iac3 mean                  → iac_avg_a
 *   fac_hz                               → freq_hz
 *   cosphi                               → cosphi
 *   temp_c                               → temp_c
 *   inverter_state_raw                   → state_raw
 *   alarm_32                             → alarm_32
 *   power_reduction_bits                 → pwr_red_bits
 *   ts                                   → ts_ms
 */
function liveFrameToSample(frame) {
  if (!frame || typeof frame !== "object") return null;
  const v1 = Number(frame.vac1) || 0;
  const v2 = Number(frame.vac2) || 0;
  const v3 = Number(frame.vac3) || 0;
  const i1 = Number(frame.iac1) || 0;
  const i2 = Number(frame.iac2) || 0;
  const i3 = Number(frame.iac3) || 0;
  return {
    ts_ms:        Number(frame.ts) || Date.now(),
    pac_w:        frame.pac == null ? null : Number(frame.pac),
    qac_var:      frame.qac_var == null ? null : Number(frame.qac_var),
    vac_avg_v:    (v1 + v2 + v3) / 3,
    iac_avg_a:    (i1 + i2 + i3) / 3,
    freq_hz:      frame.fac_hz == null ? null : Number(frame.fac_hz),
    cosphi:       frame.cosphi == null ? null : Number(frame.cosphi),
    temp_c:       frame.temp_c == null ? null : Number(frame.temp_c),
    state_raw:    frame.inverter_state_raw == null ? null : Number(frame.inverter_state_raw),
    alarm_32:     frame.alarm_32 == null ? null : Number(frame.alarm_32),
    pwr_red_bits: frame.power_reduction_bits == null ? null : Number(frame.power_reduction_bits),
  };
}

/**
 * Convert an `inverter_5min_param` row (DB SELECT result) to the compliance
 * sample shape. Used only as fallback when the live frame is unavailable.
 */
function fiveMinRowToSample(row) {
  if (!row || typeof row !== "object") return null;
  const v1 = Number(row.vac1_v) || 0;
  const v2 = Number(row.vac2_v) || 0;
  const v3 = Number(row.vac3_v) || 0;
  const i1 = Number(row.iac1_a) || 0;
  const i2 = Number(row.iac2_a) || 0;
  const i3 = Number(row.iac3_a) || 0;
  return {
    ts_ms:        Number(row.ts_ms) || Date.now(),
    pac_w:        row.pac_w == null ? null : Number(row.pac_w),
    // qac_var stored as `qac_var_avg` in the 5-min table (per Slice β migration).
    qac_var:      row.qac_var_avg == null ? null : Number(row.qac_var_avg),
    vac_avg_v:    (v1 + v2 + v3) / 3,
    iac_avg_a:    (i1 + i2 + i3) / 3,
    freq_hz:      row.freq_hz == null ? null : Number(row.freq_hz),
    cosphi:       row.cosphi == null ? null : Number(row.cosphi),
    temp_c:       row.temp_c == null ? null : Number(row.temp_c),
    state_raw:    row.inverter_state_raw == null ? null : Number(row.inverter_state_raw),
    alarm_32:     row.inv_alarms == null ? null : Number(row.inv_alarms),
    pwr_red_bits: row.pwr_red_bits == null ? null : Number(row.pwr_red_bits),
  };
}

/**
 * Resolve the compliance sample for one (ip, slave) by preferring the live
 * frame and falling back to the 5-min row when the live frame is stale or
 * missing.
 *
 * @param {Object} args
 * @param {string} args.ip             — target inverter IP
 * @param {number} args.slave          — Modbus slave / unit (1..4)
 * @param {Object} args.ipConfig       — persisted ipconfig (object-map shape)
 * @param {Object} args.liveData       — poller.getLiveData() snapshot
 * @param {Function} args.fetchFiveMinRow — () => row | null  (read-through to SQLite)
 * @param {number} [args.now]          — ms; defaults to Date.now()
 * @param {number} [args.liveFreshMs]  — staleness window; defaults to 15s
 * @returns {Object|null} sample row in compliance shape, or null when neither source has data
 */
function resolveComplianceSample({
  ip, slave, ipConfig, liveData, fetchFiveMinRow,
  now = Date.now(), liveFreshMs = LIVE_FRESH_MS_DEFAULT,
}) {
  const ipStr = String(ip || "").trim();
  const slaveNum = Number(slave);
  if (!ipStr || !Number.isFinite(slaveNum) || slaveNum < 1) return null;

  // 1) Prefer live frame (refreshes every poll cycle).
  const ipMap = buildIpToInverterMap(ipConfig);
  const inv = ipMap.get(ipStr);
  if (inv && liveData && typeof liveData === "object") {
    const frame = liveData[`${inv}_${slaveNum}`];
    if (frame) {
      const ageMs = Number.isFinite(Number(frame.ts))
        ? (now - Number(frame.ts))
        : Number.MAX_SAFE_INTEGER;
      if (ageMs <= liveFreshMs) {
        return liveFrameToSample(frame);
      }
    }
  }

  // 2) Fall back to the 5-min aggregated row (best-effort).
  if (typeof fetchFiveMinRow === "function") {
    try {
      const row = fetchFiveMinRow();
      if (row) return fiveMinRowToSample(row);
    } catch (_) { /* DB failure → null */ }
  }

  return null;
}

module.exports = {
  buildIpToInverterMap,
  liveFrameToSample,
  fiveMinRowToSample,
  resolveComplianceSample,
  LIVE_FRESH_MS_DEFAULT,
};
