"use strict";

/**
 * Phase θ.5 TDD — T2 Frequency Withstand observation.
 *
 * Pure orchestration over injected sample/clock/sleep stubs. We seed a
 * sequence of synthetic frequency readings and assert the tally + final
 * pass/fail classification matches the NGCP envelope.
 */

const assert = require("assert");
delete require.cache[require.resolve("../compliance/captureBuffer")];
delete require.cache[require.resolve("../compliance/orchestrator")];
delete require.cache[require.resolve("../compliance/testT2")];
const { OrchestratorRegistry } = require("../compliance/orchestrator");
const {
  runFrequencyObservation,
  defaultParams,
  NGCP_CONTINUOUS_LO, NGCP_CONTINUOUS_HI,
  NGCP_WITHSTAND_LO,  NGCP_WITHSTAND_HI,
} = require("../compliance/testT2");

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

console.log("\n  complianceTestT2Core.test.js — Slice θ.5\n");

(async () => {
  await test("NGCP envelope constants match Country Code 42 spec", () => {
    assert.strictEqual(NGCP_CONTINUOUS_LO, 59.7);
    assert.strictEqual(NGCP_CONTINUOUS_HI, 60.3);
    assert.strictEqual(NGCP_WITHSTAND_LO, 58.2);
    assert.strictEqual(NGCP_WITHSTAND_HI, 61.8);
  });

  await test("defaultParams clamps duration_sec to [60, 7200]", () => {
    assert.strictEqual(defaultParams({ duration_sec: 30 }).duration_sec, 60);
    assert.strictEqual(defaultParams({ duration_sec: 99999 }).duration_sec, 7200);
    assert.strictEqual(defaultParams().duration_sec, 1800);
  });

  // Build a fake sample fn that walks through a scripted frequency sequence.
  function makeScriptedSampler(frequencies, opts = {}) {
    let idx = 0;
    return async () => {
      const f = frequencies[Math.min(idx, frequencies.length - 1)];
      idx++;
      return {
        ts_ms: Date.now(),
        freq_hz: f,
        state_raw: opts.state || 2,         // 2 = grid-connected
        alarm_32: opts.alarm || 0,
      };
    };
  }

  await test("all-in-band frequencies → completed + pass=true + summary buckets", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    const fns = {
      sampleNode: makeScriptedSampler([60.0, 60.05, 60.1, 59.95, 60.0]),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    assert.strictEqual(run.status, "completed");
    // summary is an object on the orchestrator, JSON only when serialized through DB
    const s = run.summary;
    assert.ok(s.samples >= 5, `expected ≥5 samples, got ${s.samples}`);
    assert.strictEqual(s.outside_withstand_band, 0);
    assert.strictEqual(s.in_withstand_band, 0);
    assert.ok(s.in_continuous_band > 0);
    // Step pass should be true (all in continuous band)
    assert.strictEqual(run.steps[0].pass, 1);
  });

  await test("withstand-band excursions → completed + pass=false + non-zero longest excursion", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    // Sequence: continuous, continuous, withstand-low, withstand-low, continuous
    const fns = {
      sampleNode: makeScriptedSampler([60.0, 60.0, 59.0, 58.5, 60.0]),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    const s = run.summary;
    assert.ok(s.in_withstand_band >= 2, `expected withstand-band hits, got ${s.in_withstand_band}`);
    assert.strictEqual(run.steps[0].pass, 0);
    assert.ok(s.longest_excursion_ms > 0, "longest_excursion_ms should be set");
  });

  await test("outside-withstand frequencies counted separately", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    const fns = {
      sampleNode: makeScriptedSampler([60.0, 57.0, 62.5, 60.0]), // 57.0 < 58.2; 62.5 > 61.8
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    assert.ok(run.summary.outside_withstand_band >= 2);
    assert.strictEqual(run.steps[0].pass, 0);
  });

  await test("alarm transition counted in summary", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    let i = 0;
    const fns = {
      sampleNode: async () => ({
        ts_ms: Date.now(), freq_hz: 60.0, state_raw: 2,
        alarm_32: i++ < 2 ? 0 : 0x0020,  // first 2 quiet, then ALARMA_TEMPERATURA
      }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    assert.ok(run.summary.alarm_events >= 1);
  });

  await test("state changes counted across samples", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    const states = [2, 2, 3, 3, 2, 2]; // 2 → 3 → 2 transitions
    let i = 0;
    const fns = {
      sampleNode: async () => ({
        ts_ms: Date.now(), freq_hz: 60.0,
        state_raw: states[Math.min(i++, states.length - 1)],
        alarm_32: 0,
      }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    assert.ok(run.summary.state_changes >= 2, `expected ≥2 state changes, got ${run.summary.state_changes}`);
  });

  await test("abort flag stops mid-stream + final status='aborted'", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 600, sample_period_s: 1 },
    });
    let n = 0;
    const fns = {
      sampleNode: async () => {
        if (++n >= 3) run.abortRequested = true;
        return { ts_ms: Date.now(), freq_hz: 60.0, state_raw: 2, alarm_32: 0 };
      },
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    assert.strictEqual(run.status, "aborted");
  });

  await test("empty target list → finalize failed without I/O", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({ test_kind: "t2_freq_withstand", target_inverters: [], params: {} });
    const r = await runFrequencyObservation(run, {
      sampleNode: async () => { throw new Error("should not be called"); },
      sleepMs: () => Promise.resolve(),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(run.status, "failed");
  });

  await test("missing freq_hz in samples handled (not counted in tallies)", async () => {
    const reg = new OrchestratorRegistry();
    const run = reg.start({
      test_kind: "t2_freq_withstand",
      target_inverters: [{ inverter: 1, ip: "1.1.1.1", slave: 1 }],
      params: { duration_sec: 60, sample_period_s: 1 },
    });
    let n = 0;
    const fns = {
      sampleNode: async () => ({
        ts_ms: Date.now(), freq_hz: ++n <= 2 ? null : 60.0,
        state_raw: 2, alarm_32: 0,
      }),
      sleepMs: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => t++; })(),
    };
    await runFrequencyObservation(run, fns);
    // mean_hz should compute from the valid samples only
    assert.ok(run.summary.mean_hz != null);
    assert.ok(Math.abs(run.summary.mean_hz - 60.0) < 0.1);
  });
})();
