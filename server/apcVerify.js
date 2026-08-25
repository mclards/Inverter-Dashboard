"use strict";

/**
 * apcVerify.js — Slice δ closed-loop verification of curtailment writes.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice δ.
 *
 * After every successful setpoint write, schedule a deferred verification
 * task that:
 *   1. Reads the most recent inverter_5min_param row for (ip, slave)
 *      (filled by the existing fast-poll pipeline within seconds)
 *   2. Computes observed_pct = pac_w / (ratedKw × 1000)
 *   3. Reads pwr_red_bits (slow-poll capture of reg 30117) for bit 1 status
 *   4. Compares observed_pct vs requested_pct within tolerance
 *   5. Persists the outcome into apc_verify_log
 *   6. Optionally broadcasts an `apc:verify` WS event via the injected callback
 *
 * The verification is metrology-grounded (actual delivered power) rather
 * than just trusting the register echo — that's what NGCP compliance
 * evidence requires anyway.
 */

const DEFAULT_DELAY_MS = 15_000;     // settle window before the first read
const DEFAULT_TIMEOUT_MS = 60_000;   // give up after this much wall time
const DEFAULT_TOLERANCE_PCT = 5;     // ±5% of requested setpoint
const RECENT_SAMPLE_MAX_AGE_MS = 5 * 60_000;  // 5 minutes

class ApcVerifier {
  /**
   * @param {Object} deps
   *   @param {Object} deps.db            — better-sqlite3 instance
   *   @param {Function} deps.insertApcVerifyLog — db helper
   *   @param {Function} deps.getLatestApcVerify — db helper
   *   @param {Function} deps.broadcast   — optional (event, payload) → void
   *   @param {Function} deps.now         — clock injection (ms)
   *   @param {Function} deps.setTimeoutFn — scheduler injection
   */
  constructor(deps = {}) {
    this.db = deps.db || null;
    this.insertApcVerifyLog = typeof deps.insertApcVerifyLog === "function"
      ? deps.insertApcVerifyLog
      : (() => {});
    this.getLatestApcVerify = typeof deps.getLatestApcVerify === "function"
      ? deps.getLatestApcVerify
      : (() => null);
    this.broadcast = typeof deps.broadcast === "function" ? deps.broadcast : (() => {});
    this.now = typeof deps.now === "function" ? deps.now : Date.now;
    this.setTimeoutFn = typeof deps.setTimeoutFn === "function" ? deps.setTimeoutFn : setTimeout;
    this.delayMs     = Number(deps.delayMs)     || DEFAULT_DELAY_MS;
    this.timeoutMs   = Number(deps.timeoutMs)   || DEFAULT_TIMEOUT_MS;
    this.tolerance   = Number(deps.tolerancePct)|| DEFAULT_TOLERANCE_PCT;
    // Anti-thrash guard: collapse multiple rapid writes to the same node.
    this.pendingByKey = new Map();
  }

  /**
   * Compute observed_pct + bit1 from a single 5-min param row.
   * @returns {{observed_pct:number|null, bit1_active:number|null, sample_age_ms:number}}
   */
  _decodeRow(row, ratedKw, nowMs) {
    if (!row) return { observed_pct: null, bit1_active: null, sample_age_ms: Infinity };
    const sampleAge = nowMs - Number(row.ts_ms || 0);
    const ratedW = Number(ratedKw) * 1000;
    const observedPct = (Number.isFinite(ratedW) && ratedW > 0 && row.pac_w != null)
      ? (Number(row.pac_w) / ratedW) * 100
      : null;
    const bits = Number(row.pwr_red_bits);
    const bit1 = Number.isFinite(bits) ? ((bits >> 1) & 1) : null;
    return {
      observed_pct: observedPct,
      bit1_active: bit1,
      sample_age_ms: sampleAge,
    };
  }

  /**
   * Pure-function classification — extracted for tests.
   * @returns {'ok'|'mismatch'|'no_response'}
   */
  _classify(requestedPct, observedPct, bit1Active, deltaMs) {
    if (observedPct == null) return "no_response";
    const dev = Math.abs(observedPct - requestedPct);
    if (dev <= this.tolerance) {
      // For non-100% setpoints, bit 1 SHOULD be 1. If it's explicitly 0 we
      // flag a mismatch even though the power numbers happen to align.
      if (requestedPct < 99 && bit1Active === 0) return "mismatch";
      return "ok";
    }
    return "mismatch";
  }

  /**
   * Synchronously read latest 5-min param row for one node.
   * Returns null if no DB or no recent row.
   */
  _fetchLatestRow(ip, slave) {
    if (!this.db || !ip || slave == null) return null;
    try {
      return this.db.prepare(
        `SELECT ts_ms, pac_w, pwr_red_bits FROM inverter_5min_param
          WHERE inverter_ip = ? AND slave = ?
          ORDER BY ts_ms DESC LIMIT 1`
      ).get(String(ip), Number(slave)) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Public API — schedule a verification cycle for one (ip, slave) write.
   * @param {Object} args
   *   @param {string} args.inverter_ip
   *   @param {number} args.slave
   *   @param {number} args.requested_pct
   *   @param {number} args.rated_kw
   *   @param {string} [args.job_id]
   * @returns {string} key — opaque scheduler key
   */
  scheduleVerify(args) {
    const { inverter_ip, slave, requested_pct, rated_kw, job_id } = args || {};
    if (!inverter_ip || slave == null || requested_pct == null) return null;

    const key = `${inverter_ip}/${slave}`;
    const writeTs = this.now();

    // Cancel any prior pending verify for the same node — newest write wins.
    const prior = this.pendingByKey.get(key);
    if (prior) {
      try { clearTimeout(prior.timer); } catch (_) {}
      this.pendingByKey.delete(key);
    }

    // Insert a 'pending' row immediately so the UI can show "verifying…".
    try {
      this.insertApcVerifyLog({
        write_ts_ms: writeTs,
        verify_ts_ms: null,
        inverter_ip, slave,
        requested_pct: Number(requested_pct),
        observed_q15: null, observed_pct: null, bit1_active: null,
        result: "pending",
        job_id: job_id || null,
        error_message: null,
      });
    } catch (_) {}
    try { this.broadcast("apc:verify", { inverter_ip, slave, requested_pct, status: "pending" }); } catch (_) {}

    const timer = this.setTimeoutFn(() => {
      try { this._runVerifyTask(args, writeTs); }
      catch (err) {
        try {
          this.insertApcVerifyLog({
            write_ts_ms: writeTs, verify_ts_ms: this.now(),
            inverter_ip, slave,
            requested_pct: Number(requested_pct),
            observed_q15: null, observed_pct: null, bit1_active: null,
            result: "failed", job_id: job_id || null,
            error_message: String(err?.message || err),
          });
        } catch (_) {}
      } finally {
        this.pendingByKey.delete(key);
      }
    }, this.delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();

    this.pendingByKey.set(key, { timer, writeTs, requested_pct: Number(requested_pct) });
    return key;
  }

  _runVerifyTask(args, writeTs) {
    const { inverter_ip, slave, requested_pct, rated_kw, job_id } = args;
    const nowMs = this.now();
    const elapsed = nowMs - writeTs;
    if (elapsed > this.timeoutMs) {
      this.insertApcVerifyLog({
        write_ts_ms: writeTs, verify_ts_ms: nowMs,
        inverter_ip, slave,
        requested_pct: Number(requested_pct),
        observed_q15: null, observed_pct: null, bit1_active: null,
        result: "timeout", job_id: job_id || null, error_message: null,
      });
      this.broadcast("apc:verify", { inverter_ip, slave, requested_pct, status: "timeout" });
      return;
    }
    const row = this._fetchLatestRow(inverter_ip, slave);
    const decoded = this._decodeRow(row, rated_kw, nowMs);
    let result;
    if (decoded.sample_age_ms > RECENT_SAMPLE_MAX_AGE_MS) {
      result = "no_response";
    } else {
      result = this._classify(Number(requested_pct), decoded.observed_pct, decoded.bit1_active, elapsed);
    }
    this.insertApcVerifyLog({
      write_ts_ms: writeTs, verify_ts_ms: nowMs,
      inverter_ip, slave,
      requested_pct: Number(requested_pct),
      observed_q15: null,
      observed_pct: decoded.observed_pct,
      bit1_active: decoded.bit1_active,
      result, job_id: job_id || null, error_message: null,
    });
    this.broadcast("apc:verify", {
      inverter_ip, slave,
      requested_pct: Number(requested_pct),
      observed_pct: decoded.observed_pct,
      bit1_active: decoded.bit1_active,
      status: result,
    });
  }

  /** Look up the most recent verify row (for UI). */
  getLatest(ip, slave) {
    return this.getLatestApcVerify(ip, slave);
  }
}

module.exports = {
  ApcVerifier,
  DEFAULT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOLERANCE_PCT,
};
