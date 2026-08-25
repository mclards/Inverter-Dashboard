"use strict";

/**
 * orchestrator.js — NGCP compliance run state machine.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.1
 *
 * One in-process registry (`runs`) keyed by run_id. Each entry holds the
 * orchestrator state (steps, capture buffer, abort signal, finalization
 * status). The DB is the durable record; this object is the live handle.
 *
 * Pure orchestrator — does NOT talk to inverters directly. Tests T2 / T5
 * import this and drive their own Modbus calls + sample feed.
 */

const crypto = require("crypto");
const { CaptureBuffer } = require("./captureBuffer");

const VALID_KINDS = new Set([
  "t2_freq_withstand",
  "t5_apc_sweep",
  "t3_qv_sweep",      // scaffolded; writes blocked until Slice ζ
]);

// `completed_with_warnings` is the post-test end-state when every measured
// step passed but the safety-restore write back to 100% / disable-reactive
// failed (T3 / T5). The operator MUST see this distinct from a clean
// 'completed' so the unsafe end-state is visible in the UI / report.
const VALID_STATUSES = new Set([
  "running", "completed", "completed_with_warnings", "aborted", "failed",
]);

class ComplianceRun {
  constructor({ run_id, test_kind, params, target_inverters, operator_actor, dbHelpers, onEvent }) {
    if (!VALID_KINDS.has(test_kind)) throw new Error(`Unknown test_kind: ${test_kind}`);
    this.run_id = String(run_id);
    this.test_kind = String(test_kind);
    this.params = params || {};
    this.target_inverters = Array.isArray(target_inverters) ? target_inverters : [];
    this.operator_actor = operator_actor || "system";
    this.started_at_ms = Date.now();
    this.ended_at_ms = null;
    this.status = "running";
    this.error_message = null;
    this.abortRequested = false;
    this.steps = [];
    this.summary = null;
    this.db = dbHelpers || null;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    // Wire the capture buffer's overflow callback to fire a one-shot
    // `sample_overflow` event on this run so the UI can surface a warning
    // banner and the report includes a "telemetry incomplete" footnote.
    this.captureBuffer = new CaptureBuffer({
      runId: this.run_id,
      onOverflow: ({ max_samples }) => {
        this.onEvent({ kind: "sample_overflow", run_id: this.run_id, max_samples });
      },
    });
  }

  abort(reason) {
    if (this.status !== "running") return false;
    this.abortRequested = true;
    this.error_message = String(reason || "user abort");
    this.onEvent({ kind: "abort_requested", run_id: this.run_id, reason: this.error_message });
    return true;
  }

  pushSample(s) {
    if (this.status !== "running") return;
    this.captureBuffer.push(s);
  }

  beginStep({ step_idx, step_name, target_value }) {
    const step = {
      run_id: this.run_id,
      step_idx: Number(step_idx) || this.steps.length,
      step_name: String(step_name || `step_${this.steps.length}`),
      started_at_ms: Date.now(),
      ended_at_ms: null,
      target_value: target_value == null ? null : Number(target_value),
      achieved_value: null,
      deviation_pct: null,
      pass: null,
      notes: null,
    };
    this.steps.push(step);
    if (this.db?.appendComplianceStep) this.db.appendComplianceStep(step);
    this.onEvent({ kind: "step_begin", run_id: this.run_id, step });
    return step;
  }

  endStep(step, { achieved_value, deviation_pct, pass, notes } = {}) {
    if (!step) return;
    step.ended_at_ms = Date.now();
    if (achieved_value != null) step.achieved_value = Number(achieved_value);
    if (deviation_pct != null) step.deviation_pct = Number(deviation_pct);
    if (pass != null) step.pass = pass ? 1 : 0;
    if (notes != null) step.notes = String(notes);
    if (this.db?.appendComplianceStep) this.db.appendComplianceStep(step);
    this.onEvent({ kind: "step_end", run_id: this.run_id, step });
  }

  /**
   * Flush buffered samples to SQLite. Safe to call repeatedly.
   */
  flushSamples() {
    if (!this.db?.appendComplianceSample) return 0;
    const rows = this.captureBuffer.drain();
    for (const s of rows) {
      this.db.appendComplianceSample({ run_id: this.run_id, ...s });
    }
    return rows.length;
  }

  /**
   * Mark the run terminal. Idempotent — second call is a no-op.
   */
  finalize({ status = "completed", summary = null, error = null } = {}) {
    if (this.status !== "running") return false;
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    this.status = status;
    this.ended_at_ms = Date.now();
    if (summary) this.summary = summary;
    if (error) this.error_message = String(error.message || error);
    this.flushSamples();
    if (this.db?.finalizeComplianceRun) {
      this.db.finalizeComplianceRun({
        run_id: this.run_id,
        ended_at_ms: this.ended_at_ms,
        status: this.status,
        summary_json: this.summary,
        error_message: this.error_message,
      });
    }
    this.onEvent({ kind: "run_end", run_id: this.run_id, status: this.status, summary: this.summary });
    return true;
  }
}

class OrchestratorRegistry {
  constructor({ dbHelpers, onEvent } = {}) {
    this.runs = new Map();
    this.db = dbHelpers || null;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
  }

  newRunId(prefix = "run") {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  }

  start({ test_kind, params, target_inverters, operator_actor }) {
    const run_id = this.newRunId(test_kind?.split("_")[0] || "run");
    const run = new ComplianceRun({
      run_id, test_kind, params, target_inverters, operator_actor,
      dbHelpers: this.db, onEvent: this.onEvent,
    });
    this.runs.set(run_id, run);
    if (this.db?.insertComplianceRun) {
      this.db.insertComplianceRun({
        run_id, test_kind,
        started_at_ms: run.started_at_ms,
        operator_actor: run.operator_actor,
        target_inverters: run.target_inverters,
        params_json: run.params,
      });
    }
    this.onEvent({ kind: "run_begin", run_id, test_kind, target_inverters });
    return run;
  }

  get(run_id) { return this.runs.get(String(run_id)) || null; }

  abort(run_id, reason) {
    const r = this.get(run_id);
    if (!r) return false;
    return r.abort(reason);
  }

  list() {
    return Array.from(this.runs.values()).map(r => ({
      run_id: r.run_id,
      test_kind: r.test_kind,
      status: r.status,
      started_at_ms: r.started_at_ms,
      ended_at_ms: r.ended_at_ms,
      sample_count: r.captureBuffer.size(),
      step_count: r.steps.length,
    }));
  }

  /**
   * GC completed runs older than N seconds (default 1 h).
   * DB rows persist; this only clears live in-memory handles.
   */
  reapStaleRuns(maxAgeSec = 3600) {
    const cutoff = Date.now() - maxAgeSec * 1000;
    for (const [id, r] of this.runs) {
      if (r.status !== "running" && (r.ended_at_ms || 0) < cutoff) {
        this.runs.delete(id);
      }
    }
  }
}

module.exports = { ComplianceRun, OrchestratorRegistry, VALID_KINDS, VALID_STATUSES };
