"use strict";

/**
 * Slice θ.4 — T3 Q-V Capability sweep runner tests.
 *
 * Pure-function exercise of:
 *   - PF → tan(φ) → Int16 raw conversion (cross-checked at NGCP boundary)
 *   - P+Q → unsigned PF derivation
 *   - defaultParams clamping
 *   - end-to-end runner with virtual clock + mock I/O
 *   - restoration (cmd 11) on completion AND on abort
 *   - empty target list early-out
 *   - no usable PF samples → step pass=null
 */

const assert = require("assert");
const { runQvSweep, defaultParams, pfToPhiRaw, pqToPf, DEFAULT_PF_SWEEP, PHI_RAW_MAX } =
  require("../compliance/testT3.js");

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}\n    ${err.stack?.split("\n").slice(1, 3).join("\n    ")}`);
    process.exitCode = 1;
  }
}

console.log("\n  complianceTestT3Core.test.js — Slice θ.4 Q-V sweep runner\n");

/* ── Pure helpers ──────────────────────────────────────────────────────── */

test("DEFAULT_PF_SWEEP starts and ends at unity", () => {
  assert.strictEqual(DEFAULT_PF_SWEEP[0].pf, 1.00);
  assert.strictEqual(DEFAULT_PF_SWEEP[DEFAULT_PF_SWEEP.length - 1].pf, 1.00);
});

test("DEFAULT_PF_SWEEP includes both lag and lead boundaries at 0.95", () => {
  const has095Lag  = DEFAULT_PF_SWEEP.some(s => s.pf === 0.95 && s.sign === "lag");
  const has095Lead = DEFAULT_PF_SWEEP.some(s => s.pf === 0.95 && s.sign === "lead");
  assert.ok(has095Lag, "must include 0.95 lag (NGCP boundary)");
  assert.ok(has095Lead, "must include 0.95 lead (NGCP boundary)");
});

test("pfToPhiRaw: unity → 0", () => {
  assert.strictEqual(pfToPhiRaw(1.00, "0"), 0);
  assert.strictEqual(pfToPhiRaw(1.00, "lag"), 0);
});

test("pfToPhiRaw: NGCP PF 0.95 lag → ~+10770 (precise sqrt; plan rounded to 10780)", () => {
  // Precise math: tan(φ) = √(1/0.9025 − 1) = 0.32868... × 32767 = 10769.6 → 10770.
  // The plan doc rounded to 10780 from a 3-sig-fig approximation; this test
  // asserts the precise value because that's what the inverter actually receives.
  const raw = pfToPhiRaw(0.95, "lag");
  assert.ok(Math.abs(raw - 10770) <= 2, `expected ~+10770, got ${raw}`);
});

test("pfToPhiRaw: NGCP PF 0.95 lead → ~-10770 (sign-symmetric)", () => {
  const raw = pfToPhiRaw(0.95, "lead");
  assert.ok(Math.abs(raw + 10770) <= 2, `expected ~-10770, got ${raw}`);
});

test("pfToPhiRaw: PDF cmd 1 absolute limit clamped at PHI_RAW_MAX", () => {
  // PF 0.85 would exceed the limit — must be clamped, never exceed ±15870.
  const raw = pfToPhiRaw(0.85, "lag");
  assert.ok(Math.abs(raw) <= PHI_RAW_MAX, `expected clamp to ±${PHI_RAW_MAX}, got ${raw}`);
});

test("pqToPf: P=100k, Q=0 → PF=1", () => {
  assert.strictEqual(pqToPf(100000, 0), 1);
});

test("pqToPf: equal P and Q → PF≈0.707", () => {
  const pf = pqToPf(50000, 50000);
  assert.ok(Math.abs(pf - 0.7071) < 0.001, `expected ~0.707, got ${pf}`);
});

test("pqToPf: returns null when apparent power ~0", () => {
  assert.strictEqual(pqToPf(0, 0), null);
  assert.strictEqual(pqToPf(0.5, 0.5), null); // sub-1 watt apparent
});

/* ── defaultParams clamping ────────────────────────────────────────────── */

test("defaultParams: empty pf_steps → use DEFAULT_PF_SWEEP", () => {
  const p = defaultParams({ pf_steps: [] });
  assert.deepStrictEqual(p.pf_steps, DEFAULT_PF_SWEEP);
});

test("defaultParams: hold_sec clamped to [20, 900]", () => {
  assert.strictEqual(defaultParams({ hold_sec: 1 }).hold_sec, 20);
  assert.strictEqual(defaultParams({ hold_sec: 99999 }).hold_sec, 900);
});

test("defaultParams: tolerance_pct clamped to [1, 20]", () => {
  assert.strictEqual(defaultParams({ tolerance_pct: 0.1 }).tolerance_pct, 1);
  assert.strictEqual(defaultParams({ tolerance_pct: 99 }).tolerance_pct, 20);
});

test("defaultParams: pf_steps custom round-trips with sign normalize", () => {
  const p = defaultParams({ pf_steps: [{ pf: 0.97, sign: "LAG" }, { pf: 1.0, sign: "0" }] });
  assert.deepStrictEqual(p.pf_steps, [{ pf: 0.97, sign: "lag" }, { pf: 1.0, sign: "0" }]);
});

/* ── End-to-end runner with virtual clock + mock I/O ──────────────────── */

function makeMockOrch(target_inverters, params = {}) {
  const steps = [];
  const samples = [];
  const orch = {
    target_inverters,
    params,
    abortRequested: false,
    finalized: null,
    beginStep(spec) {
      const step = { ...spec, _ended: false };
      steps.push(step);
      return step;
    },
    endStep(step, payload) {
      Object.assign(step, payload);
      step._ended = true;
    },
    pushSample(s) { samples.push(s); },
    flushSamples() { /* in-memory only */ },
    finalize(payload) { this.finalized = payload; },
  };
  return { orch, steps, samples };
}

test("runQvSweep: empty target list → finalize failed without I/O", async () => {
  const { orch } = makeMockOrch([]);
  let phiCalls = 0, disableCalls = 0;
  const r = await runQvSweep(orch, {
    sendPhiTangent: () => { phiCalls += 1; return true; },
    disableReactive: () => { disableCalls += 1; return true; },
    sampleNode: () => null,
    sleepMs: () => Promise.resolve(),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(orch.finalized.status, "failed");
  assert.strictEqual(phiCalls, 0);
  assert.strictEqual(disableCalls, 0);
});

test("runQvSweep: 3-step sweep completes with all-pass and restores reactive", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: [
      { pf: 1.00, sign: "0" },
      { pf: 0.95, sign: "lag" },
      { pf: 1.00, sign: "0" },
    ],
    hold_sec: 30, settle_sec: 5, sample_period_s: 2, tolerance_pct: 5,
  };
  const { orch, steps } = makeMockOrch(targets, params);
  let virtualMs = 0;
  let disableCount = 0;
  const seenPhi = [];
  // Mock: produce samples whose cosphi matches the target PF, so deviation = 0.
  let currentTargetPf = 1.0;
  await runQvSweep(orch, {
    sendPhiTangent: (ip, slave, raw) => {
      seenPhi.push(raw);
      // Mirror the runner's mapping by reverse-engineering from raw → PF
      // (tan(φ) = raw / 32767 → PF = 1 / sqrt(1 + tan²)).
      const tan = raw / 32767;
      currentTargetPf = 1 / Math.sqrt(1 + tan * tan);
      return true;
    },
    disableReactive: () => { disableCount += 1; return true; },
    sampleNode: () => ({
      pac_w: 100000,
      qac_var: 0, // PF=1 means Q=0 by definition, but cosphi reading wins
      vac_avg_v: 230,
      cosphi: currentTargetPf,
    }),
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  assert.strictEqual(orch.finalized.status, "completed");
  assert.strictEqual(steps.length, 3);
  assert.ok(steps.every(s => s.pass === true), "every step should pass when cosphi matches target");
  assert.strictEqual(disableCount, 1, "disableReactive called once at completion");
  assert.strictEqual(seenPhi.length, 3, "one phi write per step");
});

test("runQvSweep: deviation beyond tolerance marks step fail", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: [{ pf: 0.95, sign: "lag" }],
    hold_sec: 20, settle_sec: 5, sample_period_s: 2, tolerance_pct: 1, // very tight
  };
  const { orch, steps } = makeMockOrch(targets, params);
  let virtualMs = 0;
  await runQvSweep(orch, {
    sendPhiTangent: () => true,
    disableReactive: () => true,
    sampleNode: () => ({ pac_w: 100000, qac_var: 60000, vac_avg_v: 230, cosphi: 0.80 }), // way off
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].pass, false, "PF 0.80 vs target 0.95 with 1% tol must fail");
  assert.ok(steps[0].deviation_pct > 1, "deviation should exceed tolerance");
});

test("runQvSweep: phi write failure marks step fail without samples", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = { pf_steps: [{ pf: 0.95, sign: "lag" }], hold_sec: 20, settle_sec: 5, sample_period_s: 2 };
  const { orch, steps } = makeMockOrch(targets, params);
  await runQvSweep(orch, {
    sendPhiTangent: () => false, // every write fails
    disableReactive: () => true,
    sampleNode: () => ({ pac_w: 100000, qac_var: 0, vac_avg_v: 230, cosphi: 0.95 }),
    sleepMs: () => Promise.resolve(),
    nowFn: () => 0,
  });
  assert.strictEqual(steps[0].pass, false);
  assert.match(steps[0].notes || "", /phi_tangent write failed/);
});

test("runQvSweep: abort flag stops mid-sweep and still restores reactive", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: DEFAULT_PF_SWEEP, hold_sec: 30, settle_sec: 5, sample_period_s: 2,
  };
  const { orch, steps } = makeMockOrch(targets, params);
  let virtualMs = 0;
  let stepCount = 0;
  let disableCount = 0;
  await runQvSweep(orch, {
    sendPhiTangent: () => {
      stepCount += 1;
      if (stepCount === 3) orch.abortRequested = true;
      return true;
    },
    disableReactive: () => { disableCount += 1; return true; },
    sampleNode: () => ({ pac_w: 100000, qac_var: 0, vac_avg_v: 230, cosphi: 1.0 }),
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  assert.strictEqual(orch.finalized.status, "aborted");
  assert.ok(steps.length < DEFAULT_PF_SWEEP.length, "should not have run all 21 steps");
  assert.strictEqual(disableCount, 1, "reactive must be disabled even on abort");
});

test("runQvSweep: emits qv_series in summary for chart rendering", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: [
      { pf: 1.00, sign: "0" },
      { pf: 0.95, sign: "lag" },
    ],
    hold_sec: 20, settle_sec: 5, sample_period_s: 2,
  };
  const { orch } = makeMockOrch(targets, params);
  let virtualMs = 0;
  await runQvSweep(orch, {
    sendPhiTangent: () => true,
    disableReactive: () => true,
    sampleNode: () => ({ pac_w: 100000, qac_var: 30000, vac_avg_v: 232.5, cosphi: 0.95 }),
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  const series = orch.finalized.summary?.qv_series;
  assert.ok(Array.isArray(series));
  assert.strictEqual(series.length, 2);
  assert.ok(series[0].v > 0, "v populated");
  assert.ok(series[0].q_var !== null, "q_var populated");
});

test("runQvSweep: no usable PF samples → step pass=null (skipped, not failed)", async () => {
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: [{ pf: 0.95, sign: "lag" }],
    hold_sec: 20, settle_sec: 5, sample_period_s: 2,
  };
  const { orch, steps } = makeMockOrch(targets, params);
  let virtualMs = 0;
  await runQvSweep(orch, {
    sendPhiTangent: () => true,
    disableReactive: () => true,
    // sampleNode returns null → no samples → no PF derivable
    sampleNode: () => null,
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  assert.strictEqual(steps[0].pass, null);
});

test("runQvSweep: restoration failure flips status to completed_with_warnings", async () => {
  // v2.11.x parity with T5 — when every measured PF step passes BUT the
  // post-sweep `disableReactive` write fails, the plant is left in a
  // mid-sweep PF state (NOT default reactive control). Operator MUST see
  // this as 'completed_with_warnings' rather than a clean 'completed' so
  // the unsafe end-state isn't masked.
  const targets = [{ ip: "10.0.0.1", slave: 1 }];
  const params = {
    pf_steps: [
      { pf: 1.00, sign: "0" },
      { pf: 0.95, sign: "lag" },
    ],
    hold_sec: 20, settle_sec: 5, sample_period_s: 2,
  };
  const { orch, steps } = makeMockOrch(targets, params);
  let virtualMs = 0;
  let currentTargetPf = 1.0;
  await runQvSweep(orch, {
    sendPhiTangent: (ip, slave, raw) => {
      const tan = raw / 32767;
      currentTargetPf = 1 / Math.sqrt(1 + tan * tan);
      return true;
    },
    disableReactive: () => false, // simulate restore failure
    sampleNode: () => ({ pac_w: 100000, qac_var: 0, vac_avg_v: 230, cosphi: currentTargetPf }),
    sleepMs: () => Promise.resolve(),
    nowFn: () => virtualMs,
  });
  assert.strictEqual(orch.finalized.status, "completed_with_warnings",
    `status must surface restoration failure; got ${orch.finalized.status}`);
  assert.ok(steps.every(s => s.pass === true),
    "every measured PF step should still pass independently");
});
