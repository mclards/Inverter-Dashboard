"use strict";

/**
 * Phase θ.2 TDD — T5 Active Power Control sweep.
 *
 * Mocks the I/O dependencies (sendSetpointPct, sampleNode, sleepMs) so the
 * sweep runs in synchronous time. Asserts the orchestrator state machine
 * receives the expected step sequence and final pass/fail summary.
 */

const assert = require("assert");
delete require.cache[require.resolve("../compliance/captureBuffer")];
delete require.cache[require.resolve("../compliance/orchestrator")];
delete require.cache[require.resolve("../compliance/testT5")];
const { OrchestratorRegistry } = require("../compliance/orchestrator");
const { runApcSweep, defaultParams, DEFAULT_RAMP } = require("../compliance/testT5");

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message || err}`);
      process.exitCode = 1;
    });
}

console.log("\n  complianceTestT5Core.test.js — Slice θ.2\n");

(async () => {
  await test("defaultParams supplies sensible defaults", () => {
    const p = defaultParams();
    assert.deepStrictEqual(p.ramp_pct, DEFAULT_RAMP);
    assert.strictEqual(p.hold_sec, 120);
    assert.strictEqual(p.tolerance_pct, 2);
  });

  await test("defaultParams clamps invalid hold_sec", () => {
    const p = defaultParams({ hold_sec: 1 });   // below min 30
    assert.strictEqual(p.hold_sec, 30);
    const p2 = defaultParams({ hold_sec: 9999 }); // above max 900
    assert.strictEqual(p2.hold_sec, 900);
  });

  await test("defaultParams accepts custom ramp + clamps each step", () => {
    const p = defaultParams({ ramp_pct: [50, 25, -10, 200, 75] });
    assert.deepStrictEqual(p.ramp_pct, [50, 25, 0, 100, 75]);
  });

  await test("runApcSweep — 3-step ramp completes with all-pass", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t5_apc_sweep",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { ramp_pct: [100, 50, 100], hold_sec: 30, settle_sec: 5, sample_period_s: 1, tolerance_pct: 5 },
    });
    let lastSetpoint = 0;
    const fns = {
      sendSetpointPct: async (ip, slave, pct) => { lastSetpoint = pct; return true; },
      sampleNode: async () => ({
        ts_ms: Date.now(),
        // Achieved tracks lastSetpoint exactly: pac_w = pct/100 × rated × 1000
        pac_w: (lastSetpoint / 100) * 249.41 * 1000,
      }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),  // collapse waits to no-op
    };
    const r = await runApcSweep(run, 249.41, fns);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, "completed");
    assert.strictEqual(r.steps.length, 3);
    assert.ok(r.steps.every(s => s.pass === true), "all steps should pass when achieved tracks target");
  });

  await test("runApcSweep — fails a step when achieved deviates beyond tolerance", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t5_apc_sweep",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { ramp_pct: [50, 75], hold_sec: 30, settle_sec: 5, sample_period_s: 1, tolerance_pct: 2 },
    });
    const fns = {
      sendSetpointPct: async () => true,
      // Always report 100 % regardless of setpoint → deviation will trigger fail.
      sampleNode: async () => ({ ts_ms: Date.now(), pac_w: 249.41 * 1000 }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    const r = await runApcSweep(run, 249.41, fns);
    assert.strictEqual(r.status, "failed");
    assert.ok(r.steps.every(s => s.pass === false));
  });

  await test("runApcSweep — failed setpoint write marks step fail without samples", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t5_apc_sweep",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { ramp_pct: [50], hold_sec: 30, sample_period_s: 1, tolerance_pct: 2 },
    });
    const fns = {
      sendSetpointPct: async () => false,            // simulate Modbus failure
      sampleNode: async () => ({ ts_ms: Date.now(), pac_w: 0 }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runApcSweep(run, 249.41, fns);
    // When the write fails the step is recorded on the orchestrator (with
    // pass=0) but skipped from stepResults — assert against run.steps so we
    // catch the regression on either side.
    assert.strictEqual(run.steps.length, 1);
    assert.strictEqual(run.steps[0].pass, 0);
    assert.match(run.steps[0].notes || "", /setpoint write failed/);
  });

  await test("runApcSweep — abort flag stops mid-sequence + final status='aborted'", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t5_apc_sweep",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { ramp_pct: [100, 75, 50, 25], hold_sec: 30, sample_period_s: 1, tolerance_pct: 5 },
    });
    let stepsBegun = 0;
    const fns = {
      sendSetpointPct: async () => { stepsBegun++; if (stepsBegun >= 2) run.abortRequested = true; return true; },
      sampleNode: async () => ({ ts_ms: Date.now(), pac_w: 249.41 * 1000 }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    const r = await runApcSweep(run, 249.41, fns);
    assert.strictEqual(r.status, "aborted");
    assert.ok(r.steps.length < 4, `expected <4 steps before abort, got ${r.steps.length}`);
  });

  await test("runApcSweep — empty target list → finalize failed without I/O", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({ test_kind: "t5_apc_sweep", target_inverters: [], params: {} });
    const r = await runApcSweep(run, 249.41, {
      sendSetpointPct: async () => { throw new Error("should not be called"); },
      sampleNode: async () => null,
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(run.status, "failed");
  });

  await test("runApcSweep — restoration failure flips status to completed_with_warnings", async () => {
    // v2.11.x — restore-to-100% writes after the sweep used to be
    // console-logged only; status was still "completed" even when the
    // plant was left curtailed. Operator saw a green banner while
    // production was capped at the last setpoint. Lock the new behavior:
    // every measured step passes BUT the post-sweep restore write fails,
    // so status MUST be "completed_with_warnings".
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t5_apc_sweep",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { ramp_pct: [100, 50, 100], hold_sec: 30, settle_sec: 5, sample_period_s: 1, tolerance_pct: 5 },
    });
    let lastSetpoint = 0;
    let writeCount = 0;
    const fns = {
      sendSetpointPct: async (ip, slave, pct) => {
        writeCount++;
        // Fail ONLY the post-sweep restore write (the 4th call: [100, 50, 100, restore-100])
        if (writeCount === 4) return false;
        lastSetpoint = pct;
        return true;
      },
      sampleNode: async () => ({ ts_ms: Date.now(), pac_w: (lastSetpoint / 100) * 249.41 * 1000 }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    const r = await runApcSweep(run, 249.41, fns);
    assert.strictEqual(r.ok, true, "sweep itself should still report ok");
    assert.strictEqual(r.status, "completed_with_warnings",
      "status must surface restoration failure; got " + r.status);
    assert.ok(r.steps.every(s => s.pass === true), "every measured step should still pass");
  });
})();
