"use strict";

/**
 * captureBuffer.js — in-memory ring buffer of telemetry samples for a
 * compliance test run. Flushes to compliance_run_sample on demand.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.1
 *
 * Pure data structure with no I/O. The orchestrator owns the SQLite flush.
 */

class CaptureBuffer {
  constructor({ runId, maxSamples = 50000, onOverflow } = {}) {
    if (!runId) throw new Error("CaptureBuffer requires runId");
    this.runId = String(runId);
    this.maxSamples = Math.max(100, Math.min(500000, Number(maxSamples) || 50000));
    this.samples = [];
    this.dropped = 0;
    // Optional overflow callback fired exactly once per run (the first time
    // a sample is dropped). The orchestrator uses it to log a server-side
    // warning AND broadcast a UI event so the operator running a long
    // compliance test sees that telemetry is being lost — silent drops
    // would otherwise make a false-pass report look clean.
    this._onOverflow = typeof onOverflow === "function" ? onOverflow : null;
    this._overflowNotified = false;
  }

  /**
   * Append a single sample row. Each sample represents one (ts, ip, slave) tick.
   * @param {Object} s — { ts_ms, inverter_ip, slave, pac_w, qac_var, vac_avg_v, iac_avg_a,
   *                       freq_hz, cosphi, temp_c, state_raw, alarm_32, pwr_red_bits }
   */
  push(s) {
    if (!s || typeof s !== "object") return;
    if (this.samples.length >= this.maxSamples) {
      this.dropped += 1;
      if (!this._overflowNotified) {
        this._overflowNotified = true;
        try {
          console.warn(
            `[compliance][captureBuffer] run_id=${this.runId} sample buffer full ` +
            `(${this.maxSamples}); subsequent samples will be dropped — increase ` +
            `maxSamples or shorten the test window`,
          );
          if (this._onOverflow) this._onOverflow({ run_id: this.runId, max_samples: this.maxSamples });
        } catch (_) { /* never let logging crash the runner */ }
      }
      return;
    }
    this.samples.push({
      ts_ms:        Number(s.ts_ms) || Date.now(),
      inverter_ip:  String(s.inverter_ip || ""),
      slave:        Number(s.slave) || 0,
      pac_w:        s.pac_w == null ? null : Number(s.pac_w),
      qac_var:      s.qac_var == null ? null : Number(s.qac_var),
      vac_avg_v:    s.vac_avg_v == null ? null : Number(s.vac_avg_v),
      iac_avg_a:    s.iac_avg_a == null ? null : Number(s.iac_avg_a),
      freq_hz:      s.freq_hz == null ? null : Number(s.freq_hz),
      cosphi:       s.cosphi == null ? null : Number(s.cosphi),
      temp_c:       s.temp_c == null ? null : Number(s.temp_c),
      state_raw:    s.state_raw == null ? null : Number(s.state_raw),
      alarm_32:     s.alarm_32 == null ? null : Number(s.alarm_32),
      pwr_red_bits: s.pwr_red_bits == null ? null : Number(s.pwr_red_bits),
    });
  }

  size() { return this.samples.length; }
  droppedCount() { return this.dropped; }

  /**
   * Drain — return all buffered samples and clear in-memory storage.
   * Caller (orchestrator) is responsible for persisting via DB helper.
   */
  drain() {
    const out = this.samples;
    this.samples = [];
    return out;
  }

  /**
   * Snapshot — return a shallow copy without clearing. Use for live UI tail.
   */
  tail(n = 200) {
    const k = Math.max(0, this.samples.length - n);
    return this.samples.slice(k);
  }
}

module.exports = { CaptureBuffer };
