"use strict";

/**
 * gridCodeMonitor.js — rolling 5-min × 5-sec ring per (inverter_ip, slave) of
 * grid-code telemetry (P, Q, f, V, PF) plus computed ramp rates and droop
 * slopes. Pure in-memory, no DB. Feeds the Plant Controller → Grid Code →
 * "Grid Monitor" charts and the /api/grid-code/live endpoint.
 *
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §2
 *
 * Inputs: live 5-sec poller frames. The monitor does NOT issue Modbus reads —
 * it taps the existing broadcast.
 *
 * Computed per push:
 *   - dP_dt_w_per_s          (NaN on first sample / on time-skew)
 *   - dQ_dt_var_per_s
 *   - pf_observed            preferred = cosphi if valid, else from P+Q
 *   - droop_slope_kw_per_hz   linear regression P vs f over the ring
 *   - droop_slope_kvar_per_v  same for Q vs V
 *   - droop_slope_n           sample count actually used in the regression
 *
 * Designed for cheap polling: snapshot() returns a fresh JSON-safe object
 * each call, so callers can ship it straight to the WS or HTTP response.
 */

const DEFAULT_RING_SIZE = 60;        // 60 × 5 s = 5 min
const DEFAULT_SLOT_MS   = 5_000;     // 5 s nominal sample period
const MAX_DP_DT_W_PER_S = 200_000;   // sanity clamp (200 kW/s)
const MAX_DQ_DT_VAR_PER_S = 200_000;
const DROOP_FREQ_MIN_RANGE_HZ = 0.05;   // need Δf to fit a P-f droop
const DROOP_VOLT_MIN_RANGE_V  = 0.5;    // need ΔV for Q-V
const FRESH_WINDOW_MS = 30_000;      // a node is "fresh" if last sample ≤ 30 s

function _toFinite(v) {
  // STRICT: null / undefined / "" → null. Number(null) === 0 silently turns a
  // "missing QAC" frame into a fake "PF = 1.0" reading; explicit null check
  // prevents that. NaN and non-numeric strings still return null via isFinite.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _pfFromPq(pacW, qacVar) {
  const p = _toFinite(pacW);
  const q = _toFinite(qacVar);
  if (p == null || q == null) return null;
  const s = Math.sqrt(p * p + q * q);
  if (!(s > 1)) return null;     // apparent power ≈ 0 → PF undefined
  return Math.abs(p) / s;
}

/** Linear regression y = m·x + b. Returns {slope, intercept, n}. */
function _linearRegress(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: null, intercept: null, n };
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    sumX  += x;
    sumY  += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return { slope: null, intercept: null, n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept, n };
}

class GridCodeMonitor {
  /**
   * @param {Object} [opts]
   *   @param {number} [opts.ringSize=60]
   *   @param {Function} [opts.now=Date.now]
   */
  constructor(opts = {}) {
    this.ringSize = Math.max(6, Math.min(1200, Number(opts.ringSize) || DEFAULT_RING_SIZE));
    this.now = typeof opts.now === "function" ? opts.now : Date.now;
    // key → { ip, slave, samples: [{ts_ms, pac_w, qac_var, freq_hz, vac_avg_v, pf_observed}, …] }
    this._rings = new Map();
  }

  _keyOf(ip, slave) { return `${String(ip).trim()}#${Number(slave)}`; }

  /**
   * Push one poller-frame sample. Quietly drops unusable rows so the caller
   * can fire-and-forget on every frame:tick.
   *
   * Accepts loose shapes — both poller's `frame` shape (pac=tens of W) and
   * the 5-min DB shape (pac_w) work. Pass `units = "w"` when values are
   * already in watts; default assumes "raw" (tens of W from the poller).
   */
  push(sample) {
    if (!sample || typeof sample !== "object") return;
    const ip = String(sample.inverter_ip || sample.ip || "").trim();
    const slave = Number(sample.slave);
    if (!ip || !Number.isFinite(slave) || slave < 1 || slave > 4) return;
    const ts_ms = Number(sample.ts_ms) || this.now();

    // Resolve power values to watts. The poller's `frame.pac` is already in
    // watts after parseRow:596 (`safePac = pac * 10`), so prefer the explicit
    // `pac_w` / `qac_var` keys; fall back to raw `pac` (tens-of-W) only if
    // present and pac_w is missing.
    let pac_w = _toFinite(sample.pac_w);
    if (pac_w == null && sample.pac != null && sample.units === "raw") {
      pac_w = _toFinite(sample.pac) * 10;
    }
    let qac_var = _toFinite(sample.qac_var);
    if (qac_var == null && sample.qac != null && sample.units === "raw") {
      qac_var = _toFinite(sample.qac) * 10;
    }
    const freq_hz   = _toFinite(sample.freq_hz);
    const vac_avg_v = _toFinite(sample.vac_avg_v ?? sample.vac);
    const cosphi    = _toFinite(sample.cosphi);

    // Prefer the inverter-reported cos(φ) when it's a plausible PF; else
    // derive from P+Q. Inverter posts cosphi = 0 when idle/dark.
    let pf_observed;
    if (cosphi != null && Math.abs(cosphi) >= 0.50 && Math.abs(cosphi) <= 1.00) {
      pf_observed = Math.abs(cosphi);
    } else {
      pf_observed = _pfFromPq(pac_w, qac_var);
    }

    // We accept rows even when some fields are null — the charts can plot
    // what's available and the consumer can filter.
    const key = this._keyOf(ip, slave);
    let ring = this._rings.get(key);
    if (!ring) {
      ring = { ip, slave, samples: [] };
      this._rings.set(key, ring);
    }
    ring.samples.push({ ts_ms, pac_w, qac_var, freq_hz, vac_avg_v, pf_observed });
    if (ring.samples.length > this.ringSize) {
      ring.samples.splice(0, ring.samples.length - this.ringSize);
    }
  }

  /** Drop everything (e.g. on reload). */
  reset() { this._rings.clear(); }

  /**
   * Compute the per-node derivative + droop slope from the ring contents.
   * @returns {Object} JSON-safe per-node snapshot
   */
  _computeNode(ring, nowMs) {
    const samples = ring.samples;
    const n = samples.length;
    const last = n > 0 ? samples[n - 1] : null;
    const fresh = !!last && (nowMs - Number(last.ts_ms)) < FRESH_WINDOW_MS;

    // dX/dt from the latest two samples (skip if same-tick or huge gap).
    let dP_dt = null, dQ_dt = null;
    if (n >= 2) {
      const a = samples[n - 1];
      const b = samples[n - 2];
      const dt = (Number(a.ts_ms) - Number(b.ts_ms)) / 1000;
      if (dt > 0 && dt < 60) {
        if (a.pac_w != null && b.pac_w != null) {
          const d = (a.pac_w - b.pac_w) / dt;
          dP_dt = Math.max(-MAX_DP_DT_W_PER_S, Math.min(MAX_DP_DT_W_PER_S, d));
        }
        if (a.qac_var != null && b.qac_var != null) {
          const d = (a.qac_var - b.qac_var) / dt;
          dQ_dt = Math.max(-MAX_DQ_DT_VAR_PER_S, Math.min(MAX_DQ_DT_VAR_PER_S, d));
        }
      }
    }

    // Droop slopes — regression P vs f and Q vs V over the ring. Only meaningful
    // when the independent variable actually varies. Otherwise return null
    // rather than the slope of a flat segment which is mathematically zero
    // but operationally meaningless.
    const pfs = [], pacs = [], vacs = [], qacs = [];
    for (const s of samples) {
      if (s.freq_hz != null && s.pac_w != null) {
        pfs.push(s.freq_hz);
        pacs.push(s.pac_w);
      }
      if (s.vac_avg_v != null && s.qac_var != null) {
        vacs.push(s.vac_avg_v);
        qacs.push(s.qac_var);
      }
    }
    let droop_kw_per_hz = null, droop_n_pf = 0;
    if (pfs.length >= 3) {
      const range = Math.max(...pfs) - Math.min(...pfs);
      if (range >= DROOP_FREQ_MIN_RANGE_HZ) {
        const r = _linearRegress(pfs, pacs);
        droop_n_pf = r.n;
        if (r.slope != null) droop_kw_per_hz = r.slope / 1000;  // W → kW
      } else {
        droop_n_pf = pfs.length;  // tracked but no slope (flat band)
      }
    }
    let droop_kvar_per_v = null, droop_n_qv = 0;
    if (vacs.length >= 3) {
      const range = Math.max(...vacs) - Math.min(...vacs);
      if (range >= DROOP_VOLT_MIN_RANGE_V) {
        const r = _linearRegress(vacs, qacs);
        droop_n_qv = r.n;
        if (r.slope != null) droop_kvar_per_v = r.slope / 1000;  // var → kvar
      } else {
        droop_n_qv = vacs.length;
      }
    }

    return {
      inverter_ip: ring.ip,
      slave: ring.slave,
      fresh,
      last_ts_ms: last ? last.ts_ms : null,
      sample_count: n,
      last_pac_w:   last ? last.pac_w   : null,
      last_qac_var: last ? last.qac_var : null,
      last_freq_hz: last ? last.freq_hz : null,
      last_vac_avg_v: last ? last.vac_avg_v : null,
      last_pf:      last ? last.pf_observed : null,
      dP_dt_w_per_s:  dP_dt,
      dQ_dt_var_per_s: dQ_dt,
      droop_kw_per_hz,
      droop_n_pf,
      droop_kvar_per_v,
      droop_n_qv,
      // Full ring so the UI can render the scatter without a second round-trip.
      series: samples.map(s => ({
        ts_ms: s.ts_ms,
        pac_w: s.pac_w,
        qac_var: s.qac_var,
        freq_hz: s.freq_hz,
        vac_avg_v: s.vac_avg_v,
        pf: s.pf_observed,
      })),
    };
  }

  /** Snapshot for ONE node. Returns null when no ring exists yet. */
  snapshotNode(ip, slave) {
    const key = this._keyOf(ip, slave);
    const ring = this._rings.get(key);
    if (!ring) return null;
    return this._computeNode(ring, this.now());
  }

  /** Snapshot for every known node. */
  snapshotAll() {
    const nowMs = this.now();
    const out = [];
    for (const ring of this._rings.values()) {
      out.push(this._computeNode(ring, nowMs));
    }
    return out;
  }

  /**
   * Plant-aggregate of latest values: sum of pac, qac; average f and V across
   * "fresh" nodes only. Useful for the top-strip chips on the Grid Code page.
   */
  snapshotPlant() {
    const nowMs = this.now();
    let pacSum = 0, qacSum = 0, fSum = 0, vSum = 0, fN = 0, vN = 0, fresh = 0, total = 0;
    for (const ring of this._rings.values()) {
      total += 1;
      const last = ring.samples.length > 0 ? ring.samples[ring.samples.length - 1] : null;
      if (!last) continue;
      const isFresh = (nowMs - Number(last.ts_ms)) < FRESH_WINDOW_MS;
      if (!isFresh) continue;
      fresh += 1;
      if (last.pac_w   != null) pacSum += last.pac_w;
      if (last.qac_var != null) qacSum += last.qac_var;
      if (last.freq_hz != null) { fSum += last.freq_hz; fN += 1; }
      if (last.vac_avg_v != null) { vSum += last.vac_avg_v; vN += 1; }
    }
    return {
      ts_ms: nowMs,
      fresh_count: fresh,
      total_count: total,
      plant_pac_kw:   pacSum / 1000,
      plant_qac_kvar: qacSum / 1000,
      plant_freq_hz_avg: fN > 0 ? fSum / fN : null,
      plant_vac_v_avg:   vN > 0 ? vSum / vN : null,
    };
  }
}

// Module-level singleton. Poller pushes into it; the HTTP endpoint snapshots it.
// Mirrors the apcVerifier pattern in server/index.js — no DI gymnastics.
const sharedMonitor = new GridCodeMonitor();

module.exports = {
  GridCodeMonitor,
  sharedMonitor,
  DEFAULT_RING_SIZE,
  DEFAULT_SLOT_MS,
  FRESH_WINDOW_MS,
  // Exported for tests
  _pfFromPq,
  _linearRegress,
};
