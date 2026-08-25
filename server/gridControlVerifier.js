"use strict";

/**
 * gridControlVerifier.js — closed-loop verification for Slice ζ writes.
 *
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §4
 *
 * After every successful POST /api/grid-control/{phi,reactive,disable}, this
 * module schedules a delayed `read_grid_control_state` call and classifies
 * whether the inverter actually accepted the setpoint. Pattern mirrors
 * apcVerify.js — same lifecycle, same WS shape, separate verify table.
 *
 * Pure orchestration: I/O is delegated through dependency injection so unit
 * tests can run without Python.
 */

const DEFAULT_DELAY_MS   = 10_000;   // 10 s post-write before first read
const DEFAULT_TIMEOUT_MS = 30_000;   // give up after 30 s
const DEFAULT_TOLERANCE_RAW = 200;   // phi/reactive raw tolerance (~ ±0.6% of Int16 range)

class GridControlVerifier {
  /**
   * @param {Object} deps
   *   @param {Function} deps.readGridState   — async (ip, slave) → Python read-back result
   *   @param {Function} deps.insertVerifyLog — db helper (row → void)
   *   @param {Function} [deps.broadcast]     — (event, payload) → void
   *   @param {Function} [deps.now]
   *   @param {Function} [deps.setTimeoutFn]
   *   @param {number}   [deps.delayMs]
   *   @param {number}   [deps.timeoutMs]
   *   @param {number}   [deps.toleranceRaw]
   */
  constructor(deps = {}) {
    this.readGridState   = typeof deps.readGridState === "function" ? deps.readGridState : (async () => ({ ok: false, error: "no_reader_injected" }));
    this.insertVerifyLog = typeof deps.insertVerifyLog === "function" ? deps.insertVerifyLog : (() => {});
    this.broadcast       = typeof deps.broadcast === "function" ? deps.broadcast : (() => {});
    this.now             = typeof deps.now === "function" ? deps.now : Date.now;
    this.setTimeoutFn    = typeof deps.setTimeoutFn === "function" ? deps.setTimeoutFn : setTimeout;
    this.delayMs         = Number(deps.delayMs)     || DEFAULT_DELAY_MS;
    this.timeoutMs       = Number(deps.timeoutMs)   || DEFAULT_TIMEOUT_MS;
    this.toleranceRaw    = Number(deps.toleranceRaw) || DEFAULT_TOLERANCE_RAW;
    this.pendingByKey = new Map();
  }

  /**
   * Compare an expected (raw, field) against the read-back result.
   * @returns {'ok'|'mismatch'|'no_response'}
   */
  _classify(expected, readBack) {
    if (!readBack || readBack.ok !== true) return "no_response";
    const { kind, raw } = expected;
    if (kind === "disable") {
      // Disable should clear both reactive (41008) and phi-tangent (41007).
      const phiOk = Math.abs(Number(readBack.phi_tangent_raw) || 0) <= this.toleranceRaw;
      const qOk   = Math.abs(Number(readBack.reactive_raw) || 0) <= this.toleranceRaw;
      return (phiOk && qOk) ? "ok" : "mismatch";
    }
    if (kind === "phi") {
      const obs = Number(readBack.phi_tangent_raw);
      if (!Number.isFinite(obs)) return "no_response";
      // Sign-cast UInt16 → Int16
      const signedObs = obs > 0x7FFF ? obs - 0x10000 : obs;
      return Math.abs(signedObs - Number(raw)) <= this.toleranceRaw ? "ok" : "mismatch";
    }
    if (kind === "reactive") {
      const obs = Number(readBack.reactive_raw);
      if (!Number.isFinite(obs)) return "no_response";
      const signedObs = obs > 0x7FFF ? obs - 0x10000 : obs;
      return Math.abs(signedObs - Number(raw)) <= this.toleranceRaw ? "ok" : "mismatch";
    }
    return "no_response";
  }

  /**
   * Schedule a verification cycle for one write.
   * @param {Object} args
   *   @param {string} args.inverter_ip
   *   @param {number} args.slave
   *   @param {string} args.kind     — 'phi' | 'reactive' | 'disable'
   *   @param {number} [args.raw]    — for phi/reactive; omitted for disable
   *   @param {string} [args.operator]
   * @returns {string|null} opaque key, or null on bad args
   */
  scheduleVerify(args) {
    const { inverter_ip, slave, kind, raw, operator } = args || {};
    if (!inverter_ip || slave == null) return null;
    if (kind !== "phi" && kind !== "reactive" && kind !== "disable") return null;

    const key = `${inverter_ip}/${slave}`;
    const writeTs = this.now();

    // Newest write wins — cancel any prior pending verify for the same node.
    const prior = this.pendingByKey.get(key);
    if (prior) {
      try { clearTimeout(prior.timer); } catch (_) {}
      this.pendingByKey.delete(key);
    }

    // Insert pending row so UI can show "verifying…".
    try {
      this.insertVerifyLog({
        write_ts_ms: writeTs,
        verify_ts_ms: null,
        inverter_ip, slave,
        kind,
        requested_raw: kind === "disable" ? null : Number(raw),
        observed_raw: null,
        result: "pending",
        operator: operator || null,
        error_message: null,
      });
    } catch (_) {}
    try { this.broadcast("grid_control:verify", { inverter_ip, slave, kind, status: "pending" }); } catch (_) {}

    const timer = this.setTimeoutFn(() => {
      this._runVerifyTask(args, writeTs).catch((err) => {
        try {
          this.insertVerifyLog({
            write_ts_ms: writeTs, verify_ts_ms: this.now(),
            inverter_ip, slave, kind,
            requested_raw: kind === "disable" ? null : Number(raw),
            observed_raw: null,
            result: "failed",
            operator: operator || null,
            error_message: String(err?.message || err),
          });
        } catch (_) {}
      }).finally(() => this.pendingByKey.delete(key));
    }, this.delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();

    this.pendingByKey.set(key, { timer, writeTs, kind, raw });
    return key;
  }

  async _runVerifyTask(args, writeTs) {
    const { inverter_ip, slave, kind, raw, operator } = args;
    const nowMs = this.now();
    const elapsed = nowMs - writeTs;
    if (elapsed > this.timeoutMs) {
      this.insertVerifyLog({
        write_ts_ms: writeTs, verify_ts_ms: nowMs,
        inverter_ip, slave, kind,
        requested_raw: kind === "disable" ? null : Number(raw),
        observed_raw: null,
        result: "timeout",
        operator: operator || null,
        error_message: null,
      });
      this.broadcast("grid_control:verify", { inverter_ip, slave, kind, status: "timeout" });
      return;
    }
    let readBack = null;
    try {
      readBack = await this.readGridState(inverter_ip, slave);
    } catch (err) {
      readBack = { ok: false, error: String(err?.message || err) };
    }
    const result = this._classify({ kind, raw }, readBack);
    const observedRaw = (() => {
      if (!readBack?.ok) return null;
      if (kind === "phi") return Number(readBack.phi_tangent_raw);
      if (kind === "reactive") return Number(readBack.reactive_raw);
      return null;
    })();
    this.insertVerifyLog({
      write_ts_ms: writeTs, verify_ts_ms: nowMs,
      inverter_ip, slave, kind,
      requested_raw: kind === "disable" ? null : Number(raw),
      observed_raw: observedRaw,
      result,
      operator: operator || null,
      error_message: readBack?.ok ? null : (readBack?.error || null),
    });
    this.broadcast("grid_control:verify", {
      inverter_ip, slave, kind,
      requested_raw: kind === "disable" ? null : Number(raw),
      observed_raw: observedRaw,
      status: result,
    });
  }
}

module.exports = {
  GridControlVerifier,
  DEFAULT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOLERANCE_RAW,
};
