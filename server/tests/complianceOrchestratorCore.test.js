"use strict";

/**
 * Phase θ.1 TDD — orchestrator state machine + capture buffer.
 *
 * Pure, no DB, no I/O. We inject lightweight DB stubs that capture method
 * calls so we can assert the orchestrator drives them in the right order.
 */

const assert = require("assert");
delete require.cache[require.resolve("../compliance/captureBuffer")];
delete require.cache[require.resolve("../compliance/orchestrator")];
const { CaptureBuffer } = require("../compliance/captureBuffer");
const { OrchestratorRegistry, ComplianceRun, VALID_KINDS, VALID_STATUSES } = require("../compliance/orchestrator");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function makeDbStub() {
  const log = [];
  return {
    log,
    insertComplianceRun:    (r) => { log.push(["insertRun", r.run_id, r.test_kind]); },
    finalizeComplianceRun:  (r) => { log.push(["finalizeRun", r.run_id, r.status]); },
    appendComplianceStep:   (s) => { log.push(["step", s.run_id, s.step_idx, s.step_name, s.pass]); },
    appendComplianceSample: (s) => { log.push(["sample", s.run_id, s.ts_ms, s.inverter_ip]); },
    appendComplianceArtifact: (a) => { log.push(["artifact", a.run_id, a.artifact_kind]); },
  };
}

console.log("\n  complianceOrchestratorCore.test.js — Slice θ.1\n");

test("CaptureBuffer.push + drain — basic round-trip", () => {
  const b = new CaptureBuffer({ runId: "x" });
  b.push({ ts_ms: 1, inverter_ip: "1.2.3.4", slave: 1, pac_w: 100 });
  b.push({ ts_ms: 2, inverter_ip: "1.2.3.4", slave: 1, pac_w: 200 });
  assert.strictEqual(b.size(), 2);
  const drained = b.drain();
  assert.strictEqual(drained.length, 2);
  assert.strictEqual(b.size(), 0);
  assert.strictEqual(drained[0].pac_w, 100);
});

test("CaptureBuffer respects maxSamples limit + tracks dropped", () => {
  const b = new CaptureBuffer({ runId: "x", maxSamples: 100 });
  for (let i = 0; i < 250; i++) b.push({ ts_ms: i, inverter_ip: "x", slave: 1 });
  assert.strictEqual(b.size(), 100);
  assert.strictEqual(b.droppedCount(), 150);
});

test("CaptureBuffer.tail returns trailing N samples", () => {
  const b = new CaptureBuffer({ runId: "x" });
  for (let i = 0; i < 10; i++) b.push({ ts_ms: i, inverter_ip: "x", slave: 1, pac_w: i });
  const tail3 = b.tail(3);
  assert.strictEqual(tail3.length, 3);
  assert.strictEqual(tail3[0].pac_w, 7);
});

test("CaptureBuffer rejects null + non-object inputs gracefully", () => {
  const b = new CaptureBuffer({ runId: "x" });
  b.push(null); b.push(undefined); b.push("string");
  assert.strictEqual(b.size(), 0);
});

test("ComplianceRun rejects unknown test_kind", () => {
  assert.throws(() => new ComplianceRun({ run_id: "x", test_kind: "garbage" }));
});

test("OrchestratorRegistry.start creates a run + invokes db.insertComplianceRun", () => {
  const db = makeDbStub();
  const reg = new OrchestratorRegistry({ dbHelpers: db });
  const r = reg.start({ test_kind: "t5_apc_sweep", target_inverters: [{ ip: "1.1.1.1", slave: 1 }] });
  assert.ok(r.run_id);
  assert.strictEqual(r.status, "running");
  assert.deepStrictEqual(db.log[0].slice(0, 3), ["insertRun", r.run_id, "t5_apc_sweep"]);
});

test("ComplianceRun beginStep/endStep persists step + flips pass", () => {
  const db = makeDbStub();
  const reg = new OrchestratorRegistry({ dbHelpers: db });
  const r = reg.start({ test_kind: "t5_apc_sweep", target_inverters: [{ ip: "x", slave: 1 }] });
  const step = r.beginStep({ step_idx: 0, step_name: "ramp_75pct", target_value: 75 });
  r.endStep(step, { achieved_value: 74.5, deviation_pct: 0.67, pass: true, notes: "ok" });
  assert.strictEqual(r.steps[0].pass, 1);
  // Two step writes (begin + end), bracketing the insertRun.
  const stepRows = db.log.filter(l => l[0] === "step");
  assert.strictEqual(stepRows.length, 2);
});

test("ComplianceRun.finalize is idempotent", () => {
  const db = makeDbStub();
  const reg = new OrchestratorRegistry({ dbHelpers: db });
  const r = reg.start({ test_kind: "t2_freq_withstand", target_inverters: [{ ip: "x", slave: 1 }] });
  assert.strictEqual(r.finalize({ status: "completed" }), true);
  assert.strictEqual(r.finalize({ status: "completed" }), false);  // second call no-op
  assert.strictEqual(r.status, "completed");
});

test("OrchestratorRegistry.abort flips run.abortRequested", () => {
  const reg = new OrchestratorRegistry();
  const r = reg.start({ test_kind: "t5_apc_sweep", target_inverters: [{ ip: "x", slave: 1 }] });
  assert.strictEqual(r.abortRequested, false);
  reg.abort(r.run_id, "user");
  assert.strictEqual(r.abortRequested, true);
});

test("OrchestratorRegistry.list reports per-run stats", () => {
  const reg = new OrchestratorRegistry();
  reg.start({ test_kind: "t5_apc_sweep", target_inverters: [{ ip: "x", slave: 1 }] });
  reg.start({ test_kind: "t2_freq_withstand", target_inverters: [{ ip: "x", slave: 1 }] });
  const list = reg.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list.every(l => l.status === "running" && typeof l.sample_count === "number"));
});

test("OrchestratorRegistry.reapStaleRuns drops finalized runs older than maxAge", () => {
  const reg = new OrchestratorRegistry();
  const r = reg.start({ test_kind: "t5_apc_sweep", target_inverters: [{ ip: "x", slave: 1 }] });
  r.finalize({ status: "completed" });
  // Force ended_at_ms way in the past.
  r.ended_at_ms = Date.now() - 7200_000;
  reg.reapStaleRuns(3600);
  assert.strictEqual(reg.get(r.run_id), null);
});

test("VALID_KINDS contains the three planned kinds", () => {
  assert.ok(VALID_KINDS.has("t2_freq_withstand"));
  assert.ok(VALID_KINDS.has("t5_apc_sweep"));
  assert.ok(VALID_KINDS.has("t3_qv_sweep"));
});

test("VALID_STATUSES includes completed_with_warnings (T3/T5 restoration-fail surface)", () => {
  // v2.11.x — added so a step-clean run whose post-test safety-restore
  // failed (T3 disable-reactive, T5 restore-to-100%) gets a distinct
  // status from a clean 'completed'. UI watchers and the report HTML
  // both branch on this string; locking it here prevents an accidental
  // rename or drop from silently breaking the safety surface.
  assert.ok(VALID_STATUSES.has("running"));
  assert.ok(VALID_STATUSES.has("completed"));
  assert.ok(VALID_STATUSES.has("completed_with_warnings"));
  assert.ok(VALID_STATUSES.has("aborted"));
  assert.ok(VALID_STATUSES.has("failed"));
});
